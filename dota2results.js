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

api.getLeagueListing(function(err, res) {
	leagues = res.leagues;
	winston.info("loaded " + leagues.length + " leagues");

	api.getMatchHistory({tournament_games_only:1, matches_requested: 1}, function(err, res) {
		winston.info("loading details for match " + res.matches[0].match_id);
		// now get the tournament details
		api.getMatchDetails(res.matches[0].match_id, function(err, match) {

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
	});
});




// The desired tweet looks like this:
// TOURNAMENT GAME N: TEAM def TEAM in TIME
// 


winston.info("dota2results ENDING");
