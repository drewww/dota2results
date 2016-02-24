// This file associates team ids with twitter handles.
// With this information, we can substitute team names
// for ther twitter handles which will make it easier
// for folks to see what the team is saying about
// their win, follow teams they like, and also so
// teams can see when the bot is tweeting about their
// victories.

// Contributions to this file are MUCH APPRECIATED!
// It's sort of tedious to do this by hand. If you
// want to make sure your favorite team gets tweeted,
// here's what you do.
//
// 1. Open the teams.txt file
// 2. Search for either the team name or team tag.
// 3. Look at the number on the left edge of that line, that's the team id.
// 4. Look up the twitter handle for that team.
// 5. Click 'edit' in the upper right hand corner.
// 6. Add a line in this file, following the format:
//		id : "twitter_handle",
// 7. Click 'Commit Changes'
//
// Then I'll review it and deploy it to the server
// and then the bot will know that team's twitter
// handle!

exports.teams = {
	3: "complexitylive",
	5 : "invgaming",
	7 : "DKdota2",
	15 : "LGDgaming",
	26: "mousesports",
	36: "natusvincere",
	39: "EvilGeniuses",
	40 : "TeamVirtusPro",
	46 : "team_empire",
	55 : "prdota2",
	80 : "mineski",
	162 : "FlipSid3Tactics",
	2163 : "TeamLiquidPro",
	111474 : "theAllianceGG",
	254140 : "FirstDeparture",
	293390 : "RoXKISTeam",
	350190 : "Fnatic",
	463048 : "insidiousidol",
	494197 : "IAPXctN",
	726228 : "vici_gaming",
	886928 : "RevivalDragons",
	999689 : "titanorg",
	1066490 : "nextdota",
	1075534 : "OrangeEsports",
	1079149 : "SigmaDota2",
	1194118 : "Dota2Relax",
	1245961 : "ZephyrDota",
	1252040 : "team_eHug",
	1277104: "Arrowgg",
	1333179 : "cloud9gg",
	1375614: "NewBeeCN",
	1633432: "NotTodayTeam",
	1829282: "DenialDota",
	1838315: "teamsecret",
	1846548: "HRdota2",
	// some person on twitter requested this for their team. whatevs.
	1494951 : "MaxFloPlaY"
};
