var fs = require('fs'),
	teams = require('./twitter_handles').teams,
	request = require('request'),
	winston = require('winston'),
	_ = require('underscore')._;

winston.cli();

// This is a standalone script to pull team logos from the steam
// filesystem. We don't really want to be in the business of
// doing this on the fly as part of the box scores process, plus
// we don't have a way to write to the file system on heroku,
// so we'd rather just have it in the repo. We'll depend on the
// teams twitter list to give us major-enough teams that it's
// worth getting logos for them. This is probably going to miss
// some teams but we can add them in by had if we really need to.

var KEY = process.env["STEAM_API_KEY"];

_.each(Object.keys(teams), function(team_id) {

	// first get team details to turn team_ids into logo UGC codes
	// http://api.steampowered.com/IDOTA2Match_570/GetTeamInfoByTeamID/v1
	request("http://api.steampowered.com/IDOTA2Match_570/GetTeamInfoByTeamID/v1?key="
			+ KEY + "&teams_requested=1&start_at_team_id=" + team_id, function(error, response, body) {
				// winston.info(body);

				// okay, GET THIS! The UGCUUIDs are encoded as uint64, which
				// blows out the javascript Number class, so in the file it's
				// 597017828284742302 but if you do
				// 	var foo = 597017828284742302
				// foo resolves to 597017828284742300
				// crazy huh? So we have to treat the response not as JSON, but
				// do some string gymnastics to get the UGCUUID out as a string
				// not letting the JSON parser auto-convert to a number.
				var logoUGCUUID = body.split("\"logo\": ")[1].split(",")[0];

				winston.info("logo UGCUUID: " + logoUGCUUID);
				request("http://api.steampowered.com/ISteamRemoteStorage/GetUGCFileDetails/v1/" + 
					"?key=" + KEY + "&ugcid=" + logoUGCUUID + "&appid=570", function(err, response, body) {
						// down the rabbit hole we go...
						if(err) {
							winston.error(err);
						} else {
							var response = JSON.parse(body);
							if(response.status) {
								winston.warn("No UGCFileDetails for UUID: " + logoUGCUUID);
							} else {
								var fileUrl = response.data.url;
								winston.info(fileUrl);

								request(fileUrl).pipe(fs.createWriteStream(
									'assets/teams/' + team_id + ".png"));
							}
						}
					});
			});

	// http://api.steampowered.com/ISteamRemoteStorage/GetUGCFileDetails/v1/
});