import { fetchPage } from "./fetcher.js";
import { parsePlayerProfile } from "./parse-stats.js";

const id = process.argv[2] ?? "1104883"; // Phil Salt
const bucket = Math.floor(parseInt(id) / 1000).toString();
const url = `https://cricketarchive.com/Archive/Players/${bucket}/${id}/${id}.html`;

console.log(`Fetching ${url}...`);
const html = await fetchPage(url);
console.log(`HTML length: ${html.length}`);

const profile = parsePlayerProfile(html);
console.log("\nhasT20Data:", profile.hasT20Data);
console.log("activeSince2021:", profile.activeSince2021);
console.log("\nt20Batting:", JSON.stringify(profile.t20Batting, null, 2));
console.log("\nt20Bowling:", JSON.stringify(profile.t20Bowling, null, 2));
console.log("\niplBatting:", JSON.stringify(profile.iplBatting, null, 2));
console.log("\nbio:", profile.bio.fullName, "|", profile.bio.born);
