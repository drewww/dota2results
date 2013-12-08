var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	twit = require('twit');

var config = require('./config.json');
var api = new dazzle(config.steam.key);

winston.info("dota2results STARTING");

var leagues;


// basic arc of it:
// on startup, load league listing.
// check active games periodically, tracking match ids.
// when a match id falls off the active games list, request its deets.
// process it.
// 
// DITCH MATCH HISTORY BECAUSE IT LIES

api.getLeagueListing(function(err, res) {
	leagues = res.leagues;
	winston.info("loaded " + leagues.length + " leagues");

	var now = Math.floor(new Date().getTime()/1000);
	var then = now-(60*60*24);

	winston.info("requesting matches between: " + now + " and " + then);
	api.getMatchHistory({
		tournament_games_only:1,
		// date_max: now,
		// date_min: then
	}, function(err, res) {

		if(err) {
			winston.err(err);
			return;
		}

		if(res.num_results==0) {
			winston.info("No matches within the last " + (now - then) + " seconds.");
			return;
		}

		_.each(res.matches, function(match) {
			// now get the tournament details
			winston.info("loading details for match " + match.match_id);
			api.getMatchDetails(match.match_id, function(err, match) {
				var teams = [];
				_.each(["radiant", "dire"], function(name) {
					var team = {};
					_.each(["name", "team_id", "logo", "team_complete"], function(param) {
						team[param] = match[name+"_"+param];
					});
					team["side"] = name;

					teams.push(team);
					winston.info(team);
				});

				if(!match.radiant_win) {
					var winner = teams[1];
					teams[1] = teams[0];
					teams[0] = winner;
				}

				var durationString = Math.floor(match.duration/60) + ":" + match.duration%60;
				var league = _.find(leagues, function(league) {
					return league.leagueid==match.leagueid;
				});


				// var league = {name:"test"};

				winston.info(teams[0].name + " DEF " + teams[1].name + "(" + durationString + ") in " + league.name);
			});
		})
	});
});




// The desired tweet looks like this:
// TOURNAMENT GAME N: TEAM def TEAM in TIME
// 


winston.info("dota2results ENDING");
