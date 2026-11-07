"""
Hand-authored definitions of the extra T20 leagues the simulator can play (beyond IPL and WPL).

Single source of truth for:
  - build-league-rosters.py   (squads from CricketArchive scorecards -> packages/ratings/src/league-rosters.ts,
                               team/rule metadata        -> packages/engine/src/league-defs.ts)
  - export-engine-venues.py   (home grounds -> measured venue conditions in packages/engine/src/venue-data.ts)

Rules are the leagues' publicly known playing conditions to the best of our knowledge and are approximate.
docs/LEAGUES.md lists each rule and where it is a simplification.

team tuple: (short, name, city, primary, secondary, stadium display name, venue-conditions ground, CricketArchive team name)
"""

# ---------------------------------------------------------------------------------------------
# Leagues. `season` is the most recent complete season in data/cricket.db. `ca_event` is the
# CricketArchive event-name prefix (playoff matches carry "(Final)" etc. suffixes, so a LIKE prefix
# picks up the whole season).
# ---------------------------------------------------------------------------------------------

LEAGUES = [
    {
        "competition": "Big Bash League", "id": "bbl", "name": "Big Bash League", "short": "BBL", "gender": "men", "homeCountry": "Australia",
        "ca_event": "KFC Twenty20 Big Bash 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=3, maxOverseasInSquad=6,
                      minSquadSize=16, maxSquadSize=20, squadBuilding="draft", salaryCap=1.95),
        "teams": [
            ("ADS", "Adelaide Strikers", "Adelaide", "#0080C8", "#FFD100", "Adelaide Oval", "Adelaide Oval", "Adelaide Strikers"),
            ("BRH", "Brisbane Heat", "Brisbane", "#F26522", "#0B2A4A", "The Gabba", "The Gabba", "Brisbane Heat"),
            ("HBH", "Hobart Hurricanes", "Hobart", "#5B2D86", "#FFC20E", "Ninja Stadium (Bellerive Oval)", "Bellerive Oval", "Hobart Hurricanes"),
            ("MLR", "Melbourne Renegades", "Melbourne", "#E31837", "#1D1D1B", "Marvel Stadium", "Docklands Stadium", "Melbourne Renegades"),
            ("MLS", "Melbourne Stars", "Melbourne", "#00A651", "#1D1D1B", "Melbourne Cricket Ground", "Melbourne Cricket Ground", "Melbourne Stars"),
            ("PRS", "Perth Scorchers", "Perth", "#F68B1F", "#1D1D1B", "Optus Stadium", "Perth Stadium", "Perth Scorchers"),
            ("SYS", "Sydney Sixers", "Sydney", "#E6007E", "#1D1D1B", "Sydney Cricket Ground", "Sydney Cricket Ground", "Sydney Sixers"),
            ("SYT", "Sydney Thunder", "Sydney", "#B9D300", "#1D1D1B", "Engie Stadium (Sydney Showground)", "Sydney Showground Stadium, Sydney", "Sydney Thunder"),
        ],
    },
    {
        "competition": "Women's Big Bash League", "id": "wbbl", "name": "Women's Big Bash League", "short": "WBBL", "gender": "women", "homeCountry": "Australia",
        "ca_event": "Weber Women's Big Bash League 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="wbbl", maxOverseasInXI=4, maxOverseasInSquad=6,
                      minSquadSize=13, maxSquadSize=17, squadBuilding="draft", salaryCap=1.0),
        "teams": [
            ("ADS", "Adelaide Strikers", "Adelaide", "#0080C8", "#FFD100", "Karen Rolton Oval", "Karen Rolton Oval", "Adelaide Strikers Women"),
            ("BRH", "Brisbane Heat", "Brisbane", "#F26522", "#0B2A4A", "Allan Border Field", "Allan Border Field", "Brisbane Heat Women"),
            ("HBH", "Hobart Hurricanes", "Hobart", "#5B2D86", "#FFC20E", "Ninja Stadium (Bellerive Oval)", "Bellerive Oval", "Hobart Hurricanes Women"),
            ("MLR", "Melbourne Renegades", "Melbourne", "#E31837", "#1D1D1B", "St Kilda Cricket Ground", "St Kilda Cricket Ground", "Melbourne Renegades Women"),
            ("MLS", "Melbourne Stars", "Melbourne", "#00A651", "#1D1D1B", "St Kilda Cricket Ground", "St Kilda Cricket Ground", "Melbourne Stars Women"),
            ("PRS", "Perth Scorchers", "Perth", "#F68B1F", "#1D1D1B", "WACA Ground", "WACA Ground", "Perth Scorchers Women"),
            ("SYS", "Sydney Sixers", "Sydney", "#E6007E", "#1D1D1B", "North Sydney Oval", "North Sydney Oval", "Sydney Sixers Women"),
            ("SYT", "Sydney Thunder", "Sydney", "#B9D300", "#1D1D1B", "Drummoyne Oval", "Drummoyne Oval", "Sydney Thunder Women"),
        ],
    },
    {
        "competition": "Pakistan Super League", "id": "psl", "name": "Pakistan Super League", "short": "PSL", "gender": "men", "homeCountry": "Pakistan",
        "ca_event": "HBL Pakistan Super League 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=4, maxOverseasInSquad=8,
                      minSquadSize=16, maxSquadSize=22, squadBuilding="draft", salaryCap=9.0),
        "teams": [
            ("HYK", "Hyderabad Kingsmen", "Hyderabad", "#00A6A6", "#FFB81C", "National Bank Cricket Arena", "National Bank Cricket Arena", "Hyderabad Kingsmen"),
            ("ISU", "Islamabad United", "Islamabad", "#E31E24", "#F58220", "Rawalpindi Cricket Stadium", "Rawalpindi Cricket Stadium", "Islamabad United"),
            ("KRK", "Karachi Kings", "Karachi", "#1F4E9D", "#F58220", "National Bank Cricket Arena", "National Bank Cricket Arena", "Karachi Kings"),
            ("LQ", "Lahore Qalandars", "Lahore", "#00A94F", "#ED1C24", "Gaddafi Stadium", "Gaddafi Stadium", "Lahore Qalandars"),
            ("MS", "Multan Sultans", "Multan", "#0E7C4A", "#F7C600", "Multan Cricket Stadium", "Multan Cricket Stadium", "Multan Sultans"),
            ("PZ", "Peshawar Zalmi", "Peshawar", "#FFD100", "#1D1D1B", "Imran Khan Cricket Stadium", "Imran Khan Cricket Stadium", "Peshawar Zalmi"),
            ("QG", "Quetta Gladiators", "Quetta", "#6A2C91", "#F5C400", "National Bank Cricket Arena", "National Bank Cricket Arena", "Quetta Gladiators"),
            ("RWP", "Rawalpindiz", "Rawalpindi", "#E40046", "#1D1D1B", "Rawalpindi Cricket Stadium", "Rawalpindi Cricket Stadium", "Rawalpindi Pindiz"),
        ],
    },
    {
        "competition": "SA20", "id": "sa20", "name": "SA20", "short": "SA20", "gender": "men", "homeCountry": "South Africa",
        "ca_event": "SA20 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=4, maxOverseasInSquad=7,
                      minSquadSize=16, maxSquadSize=17, squadBuilding="auction", salaryCap=50.0),
        "teams": [
            ("DSG", "Durban's Super Giants", "Durban", "#00B7C7", "#E7B900", "Kingsmead", "Kingsmead", "Durban's Super Giants"),
            ("JSK", "Joburg Super Kings", "Johannesburg", "#FDB913", "#1C3F94", "The Wanderers Stadium", "Wanderers Stadium", "Joburg Super Kings"),
            ("MICT", "MI Cape Town", "Cape Town", "#0F4DA0", "#D1AB3E", "Newlands", "Newlands", "MI Cape Town"),
            ("PRL", "Paarl Royals", "Paarl", "#E91E8C", "#2B4EA3", "Boland Park", "Boland Park, Paarl", "Paarl Royals"),
            ("PTC", "Pretoria Capitals", "Pretoria", "#1F5AA6", "#E31837", "SuperSport Park", "SuperSport Park", "Pretoria Capitals"),
            ("SEC", "Sunrisers Eastern Cape", "Gqeberha", "#F26522", "#1D1D1B", "St George's Park", "St George's Park", "Sunrisers Eastern Cape"),
        ],
    },
    {
        "competition": "The Hundred (men)", "id": "hundred-m", "name": "The Hundred (Men)", "short": "Hundred", "gender": "men", "homeCountry": "England",
        "ca_event": "The Men's Hundred 2026", "season": "2026",
        "rules": dict(matchesPerTeam=8, playoffTeams=3, playoffFormat="top3", maxOverseasInXI=5, maxOverseasInSquad=8,
                      minSquadSize=14, maxSquadSize=16, squadBuilding="auction", salaryCap=2.0, matchFormat="hundred"),
        "teams": [
            ("BPH", "Birmingham Phoenix", "Birmingham", "#E91E63", "#FDB913", "Edgbaston", "Edgbaston", "Birmingham Phoenix Men"),
            ("LDS", "London Spirit", "London", "#1E2A78", "#7AC143", "Lord's", "Lord's", "London Spirit Men"),
            ("MIL", "MI London", "London", "#004BA0", "#D1AB3E", "The Kia Oval", "The Oval", "MI London Men"),
            ("MSG", "Manchester Super Giants", "Manchester", "#C2185B", "#FFB300", "Old Trafford", "Old Trafford", "Manchester Super Giants Men"),
            ("SRL", "Sunrisers Leeds", "Leeds", "#FF822A", "#1D1D1B", "Headingley", "Headingley", "SunRisers Leeds Men"),
            ("SBR", "Southern Brave", "Southampton", "#00AEEF", "#003A70", "Utilita Bowl", "The Rose Bowl", "Southern Brave Men"),
            ("TRK", "Trent Rockets", "Nottingham", "#FFD100", "#7B1E3A", "Trent Bridge", "Trent Bridge", "Trent Rockets Men"),
            ("WLF", "Welsh Fire", "Cardiff", "#D50032", "#1D1D1B", "Sophia Gardens", "Sophia Gardens", "Welsh Fire Men"),
        ],
    },
    {
        "competition": "The Hundred (women)", "id": "hundred-w", "name": "The Hundred (Women)", "short": "Hundred W", "gender": "women", "homeCountry": "England",
        "ca_event": "The Women's Hundred 2026", "season": "2026",
        "rules": dict(matchesPerTeam=8, playoffTeams=3, playoffFormat="top3", maxOverseasInXI=5, maxOverseasInSquad=8,
                      minSquadSize=14, maxSquadSize=16, squadBuilding="auction", salaryCap=1.0, matchFormat="hundred"),
        "teams": [
            ("BPH", "Birmingham Phoenix", "Birmingham", "#E91E63", "#FDB913", "Edgbaston", "Edgbaston", "Birmingham Phoenix Women"),
            ("LDS", "London Spirit", "London", "#1E2A78", "#7AC143", "Lord's", "Lord's", "London Spirit Women"),
            ("MIL", "MI London", "London", "#004BA0", "#D1AB3E", "The Kia Oval", "The Oval", "MI London Women"),
            ("MSG", "Manchester Super Giants", "Manchester", "#C2185B", "#FFB300", "Old Trafford", "Old Trafford", "Manchester Super Giants Women"),
            ("SRL", "Sunrisers Leeds", "Leeds", "#FF822A", "#1D1D1B", "Headingley", "Headingley", "SunRisers Leeds Women"),
            ("SBR", "Southern Brave", "Southampton", "#00AEEF", "#003A70", "Utilita Bowl", "The Rose Bowl", "Southern Brave Women"),
            ("TRK", "Trent Rockets", "Nottingham", "#FFD100", "#7B1E3A", "Trent Bridge", "Trent Bridge", "Trent Rockets Women"),
            ("WLF", "Welsh Fire", "Cardiff", "#D50032", "#1D1D1B", "Sophia Gardens", "Sophia Gardens", "Welsh Fire Women"),
        ],
    },
    {
        "competition": "Caribbean Premier League", "id": "cpl", "name": "Caribbean Premier League", "short": "CPL", "gender": "men", "homeCountry": "West Indies",
        "ca_event": "Caribbean Premier League 2026", "season": "2026",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=4, maxOverseasInSquad=8,
                      minSquadSize=15, maxSquadSize=20, squadBuilding="draft", salaryCap=9.0),
        "teams": [
            ("ABF", "Antigua and Barbuda Falcons", "St John's", "#C8102E", "#00205B", "Sir Vivian Richards Stadium", "Sir Vivian Richards Stadium", "Antigua and Barbuda Falcons"),
            ("BT", "Barbados Tridents", "Bridgetown", "#0072BC", "#FFC20E", "Kensington Oval", "Kensington Oval", "Barbados Tridents"),
            ("GAW", "Guyana Amazon Warriors", "Providence", "#00A651", "#FFD100", "Providence Stadium", "Providence Stadium", "Guyana Amazon Warriors"),
            ("JK", "Jamaica Kingsmen", "Kingston", "#FFD100", "#00843D", "Sabina Park", "Sabina Park", "Jamaica Kingsmen"),
            ("SKN", "St Kitts and Nevis Patriots", "Basseterre", "#E31837", "#003DA5", "Warner Park", "Warner Park", "St Kitts and Nevis Patriots"),
            ("SLK", "St Lucia Kings", "Gros Islet", "#FDB913", "#1D1D1B", "Daren Sammy Cricket Ground", "Daren Sammy Stadium", "St Lucia Kings"),
            ("TKR", "Trinbago Knight Riders", "Port of Spain", "#3A225D", "#B3A123", "Queen's Park Oval", "Queen's Park Oval", "Trinbago Knight Riders"),
        ],
    },
    {
        "competition": "ILT20", "id": "ilt20", "name": "International League T20", "short": "ILT20", "gender": "men", "homeCountry": "UAE",
        "ca_event": "International League Twenty20 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=10, maxOverseasInSquad=17,
                      minSquadSize=17, maxSquadSize=20, squadBuilding="auction", salaryCap=45.0),
        "teams": [
            ("ADKR", "Abu Dhabi Knight Riders", "Abu Dhabi", "#4B2A7B", "#F2C94C", "Sheikh Zayed Stadium", "Sheikh Zayed Stadium", "Abu Dhabi Knight Riders"),
            ("DV", "Desert Vipers", "Dubai", "#F15A22", "#1D1D1B", "Dubai International Cricket Stadium", "Dubai International Cricket Stadium", "Desert Vipers"),
            ("DUC", "Dubai Capitals", "Dubai", "#004C93", "#EF1B23", "Dubai International Cricket Stadium", "Dubai International Cricket Stadium", "Dubai Capitals"),
            ("GG", "Gulf Giants", "Dubai", "#C8102E", "#0B1F4B", "Dubai International Cricket Stadium", "Dubai International Cricket Stadium", "Gulf Giants"),
            ("MIE", "MI Emirates", "Sharjah", "#004BA0", "#D1AB3E", "Sharjah Cricket Stadium", "Sharjah Cricket Stadium", "MI Emirates"),
            ("SW", "Sharjah Warriorz", "Sharjah", "#00B2A9", "#1D1D1B", "Sharjah Cricket Stadium", "Sharjah Cricket Stadium", "Sharjah Warriors"),
        ],
    },
    {
        "competition": "Major League Cricket", "id": "mlc", "name": "Major League Cricket", "short": "MLC", "gender": "men", "homeCountry": "USA",
        "ca_event": "Major League Cricket 2026", "season": "2026",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=8, maxOverseasInSquad=14,
                      minSquadSize=15, maxSquadSize=19, squadBuilding="auction", salaryCap=8.0),
        "teams": [
            ("LAKR", "Los Angeles Knight Riders", "Los Angeles", "#3A225D", "#B3A123", "Oakland Coliseum", "Oakland Coliseum", "Los Angeles Knight Riders"),
            ("MINY", "MI New York", "New York", "#004BA0", "#D1AB3E", "Grand Prairie Stadium", "Grand Prairie Stadium", "MI New York"),
            ("SFU", "San Francisco Unicorns", "San Francisco", "#8E24AA", "#00BFA5", "Oakland Coliseum", "Oakland Coliseum", "San Francisco Unicorns"),
            ("SEO", "Seattle Orcas", "Seattle", "#003B5C", "#00B5B8", "Central Broward Regional Park", "Central Broward Regional Park", "Seattle Orcas"),
            ("TSK", "Texas Super Kings", "Dallas", "#FFD100", "#1C3F94", "Grand Prairie Stadium", "Grand Prairie Stadium", "Texas Super Kings"),
            ("WSH", "Washington Freedom", "Washington", "#C8102E", "#0B2A4A", "Central Broward Regional Park", "Central Broward Regional Park", "Washington Freedom"),
        ],
    },
    {
        "competition": "Bangladesh Premier League", "id": "bpl", "name": "Bangladesh Premier League", "short": "BPL", "gender": "men", "homeCountry": "Bangladesh",
        "ca_event": "Bangladesh Premier League 2025/26", "season": "2025/26",
        "rules": dict(matchesPerTeam=10, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=4, maxOverseasInSquad=9,
                      minSquadSize=17, maxSquadSize=22, squadBuilding="draft", salaryCap=9.0),
        "teams": [
            ("CHR", "Chattogram Royals", "Chattogram", "#0B5FA5", "#F2A900", "Zahur Ahmed Chowdhury Stadium", "Zahur Ahmed Chowdhury Stadium", "Chattogram Royals"),
            ("DHC", "Dhaka Capitals", "Dhaka", "#C8102E", "#1D1D1B", "Shere Bangla National Stadium", "Shere Bangla National Stadium", "Dhaka Capitals"),
            ("NOE", "Noakhali Express", "Noakhali", "#00843D", "#F2A900", "Sylhet International Cricket Stadium", "Sylhet Stadium", "Noakhali Express"),
            ("RAW", "Rajshahi Warriors", "Rajshahi", "#E85D04", "#1D1D1B", "Sylhet International Cricket Stadium", "Sylhet Stadium", "Rajshahi Warriors"),
            ("RAR", "Rangpur Riders", "Rangpur", "#D7263D", "#2E294E", "Shere Bangla National Stadium", "Shere Bangla National Stadium", "Rangpur Riders"),
            ("SYT", "Sylhet Titans", "Sylhet", "#1D70B8", "#FFD100", "Sylhet International Cricket Stadium", "Sylhet Stadium", "Sylhet Titans"),
        ],
    },
    {
        "competition": "Lanka Premier League", "id": "lpl", "name": "Lanka Premier League", "short": "LPL", "gender": "men", "homeCountry": "Sri Lanka",
        "ca_event": "Lanka Premier League 2026", "season": "2026",
        "rules": dict(matchesPerTeam=8, playoffTeams=4, playoffFormat="eliminator", maxOverseasInXI=4, maxOverseasInSquad=8,
                      minSquadSize=17, maxSquadSize=22, squadBuilding="auction", salaryCap=6.0),
        "teams": [
            ("COK", "Colombo Kaps", "Colombo", "#7B1FA2", "#FFC107", "R. Premadasa Stadium", "R Premadasa Stadium", "Colombo Kaps"),
            ("DAS", "Dambulla Sixers", "Dambulla", "#E6007E", "#1D1D1B", "Rangiri Dambulla International Stadium", "Rangiri Dambulla Stadium", "Dambulla Sixers"),
            ("GAG", "Galle Gallants", "Galle", "#0B5FA5", "#FFD100", "Sinhalese Sports Club Ground", "Sinhalese Sports Club Ground", "Galle Gallants"),
            ("JAK", "Jaffna Kings", "Jaffna", "#C8102E", "#F2C94C", "P. Sara Oval", "P Sara Oval", "Jaffna Kings"),
            ("KAR", "Kandy Royals", "Kandy", "#00843D", "#F2A900", "Pallekele International Cricket Stadium", "Pallekele International Stadium", "Kandy Royals"),
        ],
    },
]


def team_id(league_id: str, short: str) -> str:
    return f"{league_id}-{short.lower()}"


def team_grounds():
    """{game team id: (ground name in venue-conditions, gender 'male'|'female')} for the extra leagues."""
    out = {}
    for lg in LEAGUES:
        gender = "female" if lg["gender"] == "women" else "male"
        for t in lg["teams"]:
            out[team_id(lg["id"], t[0])] = (t[6], gender)
    return out
