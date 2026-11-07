# Cricinfo ball-by-ball commentary scraper. Run through browser-harness on oldmac:
#   BU_NAME=cricinfo-comm BU_CDP_URL=http://127.0.0.1:9224 browser-harness < scraper.py
# Uses ONLY the page's own signed requests (hooked via fetch/XHR wrappers). No token forging.
import os, sys, re, json, gzip, time, random, traceback, datetime

ROOT = '/Volumes/Data/Developer/cricinfo-commentary'
OUT = ROOT + '/out'
COMM = OUT + '/comm'
SERIES_DIR = OUT + '/series'
LOG = ROOT + '/logs/scraper.log'
STATE_F = OUT + '/state.json'
PROG_F = OUT + '/progress.json'
INDEX_F = OUT + '/series_index.json'
STOP_F = ROOT + '/STOP'
TAB_F = OUT + '/mytab.txt'
CA_TAB = 'A7DAB069FA0A735CBC3D3C1A12395E1C'   # CricketArchive scraper's tab: NEVER touch
for d in (OUT, COMM, SERIES_DIR, ROOT + '/logs'): os.makedirs(d, exist_ok=True)

BASE = 'https://www.cricinfo.com'
BACKOFF = [60, 120, 300, 600, 1200]
MAX_BLOCK_SECONDS = 3600

HOOK = r"""
(function(){
 if(window.__hooked) return; window.__hooked=true; window.__cmts=[]; window.__nreq=0;
 const of=window.fetch;
 window.fetch=function(...a){ const u=(typeof a[0]==="string")?a[0]:(a[0]&&a[0].url);
  const p=of.apply(this,a);
  if(u&&u.indexOf("/match/comments")>-1){ window.__nreq++;
    p.then(r=>{const st=r.status; return r.clone().text().then(t=>{let j=null;try{j=JSON.parse(t)}catch(e){} window.__cmts.push({u:u,status:st,j:j,len:t.length,head:j?null:t.slice(0,200)})})}).catch(e=>window.__cmts.push({u:u,status:0,err:String(e)})); }
  return p;};
 const oo=XMLHttpRequest.prototype.open, os=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return oo.apply(this,arguments)};
 XMLHttpRequest.prototype.send=function(){ const x=this; if(x.__u&&String(x.__u).indexOf("/match/comments")>-1){window.__nreq++;x.addEventListener("loadend",function(){let j=null;try{j=JSON.parse(x.responseText)}catch(e){} window.__cmts.push({u:x.__u,status:x.status,j:j,len:(x.responseText||'').length,head:j?null:(x.responseText||'').slice(0,200)})})} return os.apply(this,arguments)};
})();
"""

_js_raw = js
def js(expr, *a, **k):
    for i in range(4):
        try: return _js_raw(expr, *a, **k)
        except RuntimeError as e:
            if 'navigated or closed' in str(e) or 'Cannot find context' in str(e): time.sleep(2.5); continue
            raise
    return _js_raw(expr, *a, **k)

def now(): return datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
def log(*a):
    line = now() + ' ' + ' '.join(str(x) for x in a)
    with open(LOG, 'a') as f: f.write(line + '\n')
    print(line, flush=True)

def jload(p, default):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return default
def jsave(p, obj):
    tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f)
    os.replace(tmp, p)

class Blocked(Exception): pass
class Stop(Exception): pass

def nap(a, b=None):
    time.sleep(random.uniform(a, b if b else a * 1.5))

# ---------------------------------------------------------------- tab handling
def my_tab():
    tid = None
    try: tid = open(TAB_F).read().strip()
    except Exception: pass
    alive = [t['targetId'] for t in list_tabs()]
    if tid and tid in alive and tid != CA_TAB:
        pass
    else:
        tid = cdp("Target.createTarget", url="about:blank")["targetId"]
        open(TAB_F, 'w').write(tid)
        log('created tab', tid)
    assert tid != CA_TAB
    switch_tab(tid)
    cdp("Page.enable")
    cdp("Page.addScriptToEvaluateOnNewDocument", source=HOOK)
    cdp("Page.bringToFront")
    return tid

def assert_mine():
    ct = current_tab()
    if 'cricketarchive' in (ct.get('url') or '') or ct['targetId'] == CA_TAB: raise RuntimeError('attached to a CricketArchive tab! abort')
    if ct['targetId'] != open(TAB_F).read().strip(): raise RuntimeError('not attached to my own tab! abort')

def nav(url):
    assert_mine()
    goto_url(url)
    wait_for_load(30)
    nap(2.5, 4.5)
    t = js("document.title") or ''
    nd = js("!!document.getElementById('__NEXT_DATA__')")
    blen = js("document.documentElement.outerHTML.length") or 0
    if 'Access Denied' in t or 'denied' in t.lower() or (not nd and blen < 6000):
        raise Blocked('title=%r len=%s' % (t, blen))
    return t

def next_data():
    s = js("(function(){const e=document.getElementById('__NEXT_DATA__');return e?e.textContent:null})()")
    return json.loads(s) if s else None

def dismiss_popups():
    try:
        js("""(function(){const b=document.getElementById('onetrust-reject-all-handler'); if(b) b.click();
          for(const e of document.querySelectorAll('button')){const t=(e.innerText||'').trim(); if(t==='Reject All'||t==='Not Now'){e.click();}}})()""")
    except Exception: pass

# ---------------------------------------------------------------- series discovery
SEASONS = []
for y in range(2007, 2027):
    SEASONS.append('%d' % y)
    SEASONS.append('%d/%02d' % (y, (y + 1) % 100))

def classify(name, season):
    n = name.lower().strip()
    yr = int(season[:4]) + (1 if '/' in season else 0)     # season end year (BBL 2020/21 -> 2021)
    women = "women" in n
    if re.search(r'indian premier league|^ipl\b', n) and not women: return 1, 'IPL'
    if n.startswith("women's premier league"): return 1, 'WPL'
    if re.search(r"^(icc )?(men's |women's )?(t20 world cup|world t20|world twenty20)$", n): return 2, 'T20WC'
    if yr >= 2021:
        if re.search(r'big bash', n): return 3, 'WBBL' if women else 'BBL'
        if n == 'pakistan super league': return 3, 'PSL'
        if re.search(r'^sa20$', n): return 3, 'SA20'
        if n.startswith('the hundred') and 'competition' in n: return 3, 'HUNDRED_W' if women else 'HUNDRED_M'
        if 'caribbean premier league' in n: return 3, 'CPL'
        if n == 'international league t20': return 3, 'ILT20'
        if n == 'major league cricket': return 3, 'MLC'
    if yr >= 2023 and re.search(r't20i (series|match)$|twenty20 international|^asia cup', n) and not re.search(r'qualif|warm-up|under-|unofficial|a women|a v ', n):
        top = r"india|australia|england|pakistan|new zealand|south africa|west indies|sri lanka|bangladesh|afghanistan|ireland|zimbabwe"
        if re.search(top, n): return 2, 'T20I'
    return None, None

def discover():
    idx = jload(INDEX_F, {'seasons_done': [], 'series': {}})
    for s in SEASONS:
        if s in idx['seasons_done']: continue
        url = BASE + '/ci/engine/series/index.html?season=%s;view=season' % s.replace('/', '%2F')
        log('discover season', s)
        nav(url); dismiss_popups()
        rows = js("""(function(){return JSON.stringify([...document.querySelectorAll('section.series-summary-block')].map(sec=>{
            const a=sec.querySelector('.teams a'); const dl=sec.querySelector('.date-location'); const ri=sec.querySelector('.result-info');
            return {name:a?a.innerText.trim():'', href:a?a.href:'', dates:dl?dl.innerText.trim():'', result:ri?ri.innerText.trim():''}}))})()""")
        if not rows:
            log('no rows for season', s, js('document.title'), js('location.href')); rows = '[]'
        rows = json.loads(rows)
        for r in rows:
            m = re.search(r'/series/(.+)-(\d+)(?:/|$)', r['href'])
            if not m: continue
            sid = int(m.group(2))
            tier, comp = classify(r['name'], s)
            idx['series'][str(sid)] = {'id': sid, 'slug': m.group(1), 'name': r['name'], 'season': s,
                                       'dates': r['dates'], 'tier': tier, 'comp': comp}
        idx['seasons_done'].append(s)
        jsave(INDEX_F, idx)
        nap(5, 9)
    return idx

def series_matches(sr):
    """Match list for a series (cached). Uses the fixtures page __NEXT_DATA__."""
    f = '%s/%s.json' % (SERIES_DIR, sr['id'])
    c = jload(f, None)
    if c: return c
    nav('%s/series/%s-%s/match-schedule-fixtures-and-results' % (BASE, sr['slug'], sr['id']))
    nd = next_data()
    content = nd['props']['appPageProps']['data']['content']
    out = []
    for m in content.get('matches', []):
        teams = []
        for t in m.get('teams', []):
            tt = t.get('team') or {}
            teams.append({'id': tt.get('id'), 'objectId': tt.get('objectId'), 'name': tt.get('name'), 'long': tt.get('longName'),
                          'score': t.get('score'), 'inningNumbers': t.get('inningNumbers')})
        out.append({'objectId': m['objectId'], 'slug': m['slug'], 'title': m.get('title'), 'stage': m.get('stage'), 'state': m.get('state'),
                    'status': m.get('status'), 'statusText': m.get('statusText'), 'startDate': m.get('startDate'),
                    'generalClassId': m.get('generalClassId'), 'internationalClassId': m.get('internationalClassId'),
                    'isCancelled': m.get('isCancelled'), 'coverage': m.get('coverage'), 'ground': (m.get('ground') or {}).get('name'),
                    'winnerTeamId': m.get('winnerTeamId'), 'teams': teams,
                    'seriesSlug': (m.get('series') or {}).get('slug'), 'seriesObjectId': (m.get('series') or {}).get('objectId')})
    res = {'series': sr, 'matches': out, 'fetched': now()}
    jsave(f, res)
    return res

# ---------------------------------------------------------------- per-match
def strip(o):
    DROP = re.compile(r'image|logo|headshot|peerurls|livestream|highlightsurl', re.I)
    if isinstance(o, dict): return {k: strip(v) for k, v in o.items() if not DROP.search(k)}
    if isinstance(o, list): return [strip(v) for v in o]
    return o

_ROWS = """const c=[...document.querySelectorAll('div')].filter(e=>{const h=e.offsetHeight;return h>40&&h<600&&e.children.length<=6&&/^\\d{1,2}\\.\\d\\n/.test(e.innerText||'')});
 if(!c.length) return 0; c.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
 const row=c[c.length-1];"""
# the page's infinite-scroll trigger fires when the end of its list scrolls into view: first the last ball row, then (fan comments and
# blurbs can follow the last ball row) the last child of the list, then past it
LASTROW_JS = "(function(){" + _ROWS + " row.scrollIntoView({block:'center'}); return c.length;})()"
LASTCHILD_JS = "(function(){" + _ROWS + " const t=(row.parentElement&&row.parentElement.lastElementChild)||row; t.scrollIntoView({block:'center'}); return c.length;})()"
PASTEND_JS = "(function(){" + _ROWS + " const t=(row.parentElement&&row.parentElement.lastElementChild)||row; const r=t.getBoundingClientRect(); window.scrollTo(0, window.scrollY+r.bottom-window.innerHeight+400); return c.length;})()"

def innings_ok(st, strict=False):
    """an innings is complete when it reaches over 1 and has every over up to its last (no page missing)"""
    if not st: return False
    overs = {c.get('overNumber') for c in st.values() if c.get('overNumber')}
    return bool(overs) and min(overs) == 1 and len(overs) == max(overs)

class Collector:
    def __init__(self): self.resp = []; self.statuses = []
    def pull(self):
        got = js("JSON.stringify(window.__cmts.splice(0))")
        arr = json.loads(got) if got else []
        for r in arr:
            self.statuses.append({'u': r['u'].split('?')[1] if '?' in r['u'] else r['u'], 'status': r.get('status'), 'n': len(((r.get('j') or {}).get('comments')) or [])})
            self.resp.append(r)
        return arr

def wait_responses(col, timeout=14):
    """wait until no in-flight requests and at least one response arrived (or timeout)"""
    t0 = time.time(); got = []
    while time.time() - t0 < timeout:
        got += col.pull()
        inflight = js("window.__nreq - (window.__done||0)")  # not tracked precisely; rely on count change
        if got: 
            time.sleep(0.45); got += col.pull(); return got
        time.sleep(0.5)
    return got

def inn_of(u):
    m = re.search(r'inningNumber=(\d+)', u); return int(m.group(1)) if m else None

def drain_innings(col, store, nextover, inn):
    """Scroll the end of the commentary list into view until the page's own loads reach the start of the innings."""
    idle = 0; loads = 0
    variants = [LASTROW_JS, LASTCHILD_JS, PASTEND_JS]
    while nextover not in (None, 0) or idle == 0 and loads == 0:
        got = []
        # normal trigger first; if the page does not react, try the other ways of bringing the list end into view, then jiggle
        for k, trig in enumerate(variants + ["window.scrollBy(0,-500)"] + variants):
            js(trig)
            got = [g for g in wait_responses(col, 9 if k < len(variants) else 6) if inn_of(g['u']) == inn]
            if got: break
        if not got:
            idle += 1
            if idle >= 3: return False
            nap(3, 6)
            continue
        idle = 0
        for g in got:
            if g.get('status') in (403, 429) or g.get('j') is None:
                raise Blocked('api status %s head=%r' % (g.get('status'), g.get('head')))
            for c in g['j'].get('comments', []): store[c['id']] = c
            nextover = g['j'].get('nextInningOver')
            loads += 1
        if nextover in (None, 0): return True
        nap(0.25, 0.8)
    return True

ABBRS = []
def list_innings_options():
    """locate the team-selector button (text = a team abbreviation) in the commentary filter row; the page renders it lazily,
    so poll and nudge the scroll for a few seconds"""
    for i in range(7):
        r = js("""(function(){const ab=%s;
          const btn=[...document.querySelectorAll('button')].find(e=>ab.indexOf((e.innerText||'').trim())>-1);
          if(!btn) return null;
          btn.scrollIntoView({block:'center'}); const b=btn.getBoundingClientRect();
          return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2,t:(btn.innerText||'').trim()})})()""" % json.dumps(ABBRS))
        if r: return json.loads(r)
        js("window.scrollBy(0, 900)"); time.sleep(1.5)
    return None

def open_dropdown_options():
    b = list_innings_options()
    if not b: return None, []
    click_at_xy(b['x'], b['y']); nap(0.8, 1.4)
    r = js("""(function(){return JSON.stringify([...document.querySelectorAll('li')].filter(e=>e.offsetHeight>0&&e.offsetHeight<60&&e.className.indexOf('ds-w-full')>-1).map(e=>{const r=e.getBoundingClientRect();return {t:(e.innerText||'').trim(),x:r.x+r.width/2,y:r.y+r.height/2}}))})()""")
    return b, json.loads(r)

def scrape_match(mm, series, prior=None, attempt=0):
    url = '%s/series/%s-%s/%s-%s/ball-by-ball-commentary' % (BASE, series['slug'], series['id'], mm['slug'], mm['objectId'])
    t0 = time.time()
    nav(url); dismiss_popups()
    nd = next_data()
    data = nd['props']['appPageProps']['data']
    content = data['content']; match = data.get('match')
    cur = content.get('currentInningNumber'); innings = content.get('innings') or []
    inn_nums = sorted({i['inningNumber'] for i in innings}) or [cur]
    global ABBRS
    ABBRS = sorted({(i.get('team') or {}).get('abbreviation') or (i.get('team') or {}).get('name') for i in innings} - {None})
    col = Collector(); stores = {n: {} for n in inn_nums}
    skip_ok = set()
    for n_, st_ in (prior or {}).items():
        stores.setdefault(n_, {}).update(st_)
        if innings_ok(st_): skip_ok.add(n_)
    for c in content.get('comments') or []:
        stores.setdefault(c.get('inningNumber') or cur, {})[c['id']] = c
    complete = {}
    # 1) current innings via page's own infinite scroll
    if cur in skip_ok: complete[cur] = True
    else: complete[cur] = drain_innings(col, stores[cur], content.get('nextInningOver'), cur) if content.get('nextInningOver') not in (None, 0) else True
    # 2) other innings through the team dropdown
    for n in inn_nums:
        if n in complete: continue
        if n in skip_ok: complete[n] = True; continue
        done = False
        for _try in range(2):
            b, opts = open_dropdown_options()
            if not opts: break
            # click the option that is not the currently selected team; if several, try the ones we haven't loaded
            tried = False
            for o in opts:
                if o['t'] == (b or {}).get('t') and len(opts) > 1: continue
                col.pull(); 
                click_at_xy(o['x'], o['y']); nap(1.2, 2.0)
                got = wait_responses(col, 12)
                nums = {inn_of(g['u']) for g in got}
                if n in nums:
                    tried = True
                    for g in got:
                        if g.get('status') in (403, 429) or g.get('j') is None: raise Blocked('api status %s' % g.get('status'))
                        if inn_of(g['u']) == n:
                            for c in g['j'].get('comments', []): stores[n][c['id']] = c
                            nxt = g['j'].get('nextInningOver')
                    complete[n] = drain_innings(col, stores[n], nxt, n) if nxt not in (None, 0) else True
                    done = True
                    break
                else:
                    # option led to another innings (e.g. a super over) -> keep what it loaded
                    for g in got:
                        k = inn_of(g['u'])
                        if g.get('j') is not None and k in stores:
                            for c in g['j'].get('comments', []): stores[k][c['id']] = c
                    js("document.body.click()") ; nap(0.5, 1)
                    b, opts2 = open_dropdown_options()
            if done: break
        if not done: complete[n] = False
    # assemble
    out_comments = {}
    stats = {}
    for n, st in stores.items():
        arr = sorted(st.values(), key=lambda c: (c.get('oversUnique') or 0, c['id']))
        out_comments[str(n)] = arr
        overs = sorted({c.get('overNumber') for c in arr if c.get('overNumber')})
        stats[str(n)] = {'balls': len(arr), 'overs': len(overs), 'maxOver': max(overs) if overs else 0, 'complete': bool(complete.get(n))}
    bad = [n for n in stores if not (complete.get(n) and innings_ok(stores[n], True))]
    if bad and attempt < 2 and any(stores[n] for n in stores):
        log('incomplete innings %s of %s (attempt %d), retrying' % (bad, mm['slug'], attempt + 1))
        nap(20, 40)
        return scrape_match(mm, series, prior=stores, attempt=attempt + 1)
    rec = {'v': 1, 'matchId': mm['objectId'], 'seriesId': series['id'], 'seriesSlug': series['slug'], 'slug': mm['slug'], 'url': url,
           'comp': series.get('comp'), 'scrapedAt': now(), 'fixture': mm,
           'page': {'match': strip(match), 'currentInningNumber': cur, 'innings': strip(innings)},
           'commentary': out_comments, 'stats': stats, 'requests': col.statuses, 'secs': round(time.time() - t0, 1)}
    return rec

def write_match(rec):
    f = '%s/%s-%s.jsonl.gz' % (COMM, rec['seriesId'], rec['seriesSlug'])
    line = (json.dumps(rec, separators=(',', ':')) + '\n').encode()
    with gzip.open(f, 'ab') as g: g.write(line)
    return os.path.basename(f), len(line)

# ---------------------------------------------------------------- main loop
def eligible(mm):
    if mm.get('isCancelled'): return False
    if mm.get('state') != 'POST': return False
    if not (mm.get('generalClassId') == 6 or mm.get('internationalClassId') == 3): return False
    return True

def main():
    state = jload(STATE_F, {'done': {}, 'failed': {}})
    run0 = time.time(); ndone0 = 0; balls_run = 0
    my_tab()
    open(ROOT + '/scraper.pid', 'w').write(str(os.getpid()))
    log('=== scraper start; done so far', len(state['done']))
    block_since = None; block_n = 0
    def guarded(fn, *a):
        nonlocal block_since, block_n
        while True:
            if os.path.exists(STOP_F): raise Stop()
            try:
                r = fn(*a); block_since = None; block_n = 0; return r
            except Blocked as e:
                block_since = block_since or time.time()
                if time.time() - block_since > MAX_BLOCK_SECONDS:
                    log('BLOCKED for over an hour continuously -> stopping'); open(ROOT + '/STOPPED_BLOCKED', 'w').write(now()); raise Stop()
                w = BACKOFF[min(block_n, len(BACKOFF) - 1)]; block_n += 1
                log('BLOCKED (%s) backing off %ss' % (e, w))
                for _ in range(w // 10):
                    if os.path.exists(STOP_F): raise Stop()
                    time.sleep(10)
                try: my_tab()
                except Exception as ee: log('my_tab failed', ee)
    try:
        idx = guarded(discover)
        ORDER = ['IPL', 'WPL', 'T20WC', 'T20I', 'BBL', 'WBBL', 'PSL', 'SA20', 'HUNDRED_M', 'HUNDRED_W', 'CPL', 'ILT20', 'MLC']
        for s_ in idx['series'].values():
            s_['tier'], s_['comp'] = classify(s_['name'], s_['season'])
        sel = [s for s in idx['series'].values() if s['tier']]
        sel.sort(key=lambda s: (ORDER.index(s['comp']), -int(s['season'][:4]), s['id']))
        log('series selected', len(sel), 'by tier', {t: sum(1 for s in sel if s['tier'] == t) for t in (1, 2, 3)})
        prog = {'started': now(), 'matches_this_run': 0, 'known_total': 0}
        known_total = 0
        for sr in sel:
            try: sm = guarded(series_matches, sr)
            except Stop: raise
            except Exception as e:
                log('series fail', sr['id'], sr['name'], repr(e)); continue
            todo = [m for m in sm['matches'] if eligible(m)]
            known_total += len(todo)
            log('series', sr['season'], sr['name'], sr['id'], 'eligible', len(todo), 'already', sum(1 for m in todo if str(m['objectId']) in state['done']))
            for mm in todo:
                key = str(mm['objectId'])
                dn = state['done'].get(key)
                if dn and (dn.get('complete', True) or dn.get('retried')): continue   # incomplete ones get one more try
                if state['failed'].get(key, {}).get('n', 0) >= 3: continue
                if os.path.exists(STOP_F): raise Stop()
                try:
                    rec = guarded(scrape_match, mm, sr)
                except Stop: raise
                except Exception as e:
                    f = state['failed'].setdefault(key, {'n': 0}); f['n'] += 1; f['err'] = repr(e)[:300]; f['series'] = sr['id']
                    log('FAIL', key, mm['slug'], repr(e)); log(traceback.format_exc()[-600:]); jsave(STATE_F, state)
                    try: my_tab()
                    except Exception as ee: log('my_tab failed', ee)
                    nap(20, 40); continue
                fn, nb = write_match(rec)
                balls = sum(s['balls'] for s in rec['stats'].values())
                state['done'][key] = {'retried': bool(dn), 'file': fn, 'balls': balls, 'series': sr['id'], 'comp': sr['comp'], 'season': sr['season'], 'complete': all(s['complete'] for s in rec['stats'].values()), 'at': now()}
                state['failed'].pop(key, None)
                jsave(STATE_F, state)
                ndone0 += 1; balls_run += balls
                el = (time.time() - run0) / 3600
                rate = ndone0 / el if el > 0 else 0
                remaining_known = max(0, known_total - len(state['done']))
                jsave(PROG_F, {'updated': now(), 'done_total': len(state['done']), 'done_this_run': ndone0, 'balls_this_run': balls_run,
                               'matches_per_hour': round(rate, 1), 'known_eligible_total': known_total, 'remaining_known': remaining_known,
                               'eta_hours_known': round(remaining_known / rate, 1) if rate else None, 'failed': len(state['failed']),
                               'current': '%s %s' % (sr['name'], sr['season'])})
                log('OK %s %s %s balls=%d secs=%s stats=%s rate=%.1f/h' % (sr['comp'], sr['season'], mm['slug'], balls, rec['secs'], json.dumps({k: (v['balls'], v['maxOver'], v['complete']) for k, v in rec['stats'].items()}), rate))
                nap(5, 11)
        log('queue exhausted')
    except Stop:
        log('stopped by STOP file / block limit')
    except Exception as e:
        log('FATAL', repr(e)); log(traceback.format_exc())
    log('=== scraper exit')

if os.environ.get("CC_NOMAIN") != "1": main()
