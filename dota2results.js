var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	EventEmitter = require('events').EventEmitter,
	fs = require('fs'),
	twit = require('twit');

winston.cli();
winston.info("dota2results STARTING");



// Here's the overall system flow:
// 	1. On startup, get a list of leagues. Store it.
//  2. Start the main update loop, once every 60 seconds.
//		a. Check to see if our league listing is greater than 24 hours out of date.
//			If it is, refresh it.
//		b. Hit the live league games list. Not to farm match_ids (which aren't shown there)
//			but to get a list of which leagues to check.
//				- if we don't have a list of already-seen matchIds, then start one.
//		c. Compare the list of most recent games for each of the live leagues to
//			the list of last games we've seen for that league. 
//		d. If it's a new id, then fetch the full match history for it and tweet it up. 

exports.ResultsServer = function() {

}

exports.ResultsServer.prototype = {
	leagues: null,
	lastLeagueUpdate: null,

	teams: null,
	lastTeamUpdate: null,

	liveGames: null,
	lastLiveGamesUpdate: null,

	starting: true,

	updater: null,

	activeLeagueIds: null,

	blacklistedLeagueIds: null,

	isDemo: false,

	matchIdsToTweet: null,

	init: function(isDemo) {
		winston.info("INIT ResultsServer");

		// maps leagueIds to times we last saw that league
		// with an active game.
		this.activeLeagueIds = {};

		try {
			this.leagues = require('/tmp/leagues.json');
			this.lastLeagueUpdate = new Date().getTime();
		} catch (e) {
			this.leagues = {};
		}

		this.teams = {};

		this.matchIdsToTweet = [];

		// auto-discard any super rapid tweets
		// this will cull some of the potential horror of auto tweeting
		// every result in the list. Might also catch legit multiple games
		// ending in rapid succession; i'm not sure yet.
		this.tweet = _.throttle(this._tweet, 500);
		this.altTweet = _.throttle(this._altTweet, 500);

		this.blacklistedLeagueIds = JSON.parse(process.env.BLACKLISTED_LEAGUE_IDS);

		this.isDemo = isDemo;
	},

	start: function() {
		winston.info("START ResultsServer");

		this.twitter = new twit({
		    consumer_key:         process.env.TWITTER_CONSUMER_KEY
		  , consumer_secret:      process.env.TWITTER_CONSUMER_SECRET
		  , access_token:         process.env.TWITTER_ACCESS_TOKEN
		  , access_token_secret:  process.env.TWITTER_ACCESS_TOKEN_SECRET
		});

		this.twitterAlt = new twit({
		    consumer_key:         process.env.TWITTER_ALT_CONSUMER_KEY
		  , consumer_secret:      process.env.TWITTER_ALT_CONSUMER_SECRET
		  , access_token:         process.env.TWITTER_ALT_ACCESS_TOKEN
		  , access_token_secret:  process.env.TWITTER_ALT_ACCESS_TOKEN_SECRET
		});

		this.on("live-games:update", _.bind(function() {
			var leagues = this.getLeaguesWithLiveGames();

			_.each(leagues, _.bind(function(league) {
				this.activeLeagueIds[league] = new Date().getTime();
			}, this));

			_.each(Object.keys(this.activeLeagueIds), _.bind(function(league) {
				var lastSeen = this.activeLeagueIds[league];

				var now = new Date().getTime();

				// if it's been more than ten minutes, stop checking.
				if((now - lastSeen) > (1000*60*10)) {
					winston.info("Discarding " + league + " from tracking; been too long since we've seen it.");
					delete this.activeLeagueIds[league];
				}
			}, this));

			// always run on the last set not this set, because if a game
			// just ended its league might not be in the current list
			// anymore.

			// winston.info("Checking leagueIds: " + JSON.stringify(Object.keys(this.activeLeagueIds)));

			var matchCounts = {};
			_.each(Object.keys(this.activeLeagueIds), _.bind(function(leagueId) {
				var league = this.leagues[leagueId];

				if(_.isUndefined(league.lastSeenMatchIds)) {
					winston.info("Found un-initialized league: " + league.name);		
					league.lastSeenMatchIds = [];
					league.init = true;
				}

				this.getRecentLeagueMatches(leagueId, _.bind(function(matches) {
					// winston.info("Found " + matches.length + " matches for league: " + this.leagues[leagueId].name);

					matchCounts[leagueId] = matches.length;

					this.leagues[leagueId].init = false;

					// ugly but I'm too lazy to work out the flow control here.
					if(Object.keys(matchCounts).length==Object.keys(this.activeLeagueIds).length) {
						var out = "";

						_.each(Object.keys(matchCounts), function(k) {
							out += k + ":" + matchCounts[k] + "\t";
						});

						winston.info(this.liveGames.length + " -> " + out);
					}
				}, this));
			}, this));
			this.saveLeagues();

			// now check and see if any matches didn't get successfully processed. If so, 
			// reprocess them.

			if(this.matchIdsToTweet.length > 0) {
				winston.info(this.matchIdsToTweet.length + " queued matches that haven't been successfully tweeted, retrying now");
				_.each(this.matchIdsToTweet, _.bind(function(matchId) {
					this.processFinishedMatch(matchId);
				}, this));
			}
		}, this));

		if(Object.keys(this.leagues).length==0) {
			this.updateLeagueListing();
		}

		if(Object.keys(this.teams).length==0) {
			this.updateTeamListing();
		}

		var duration = 60*1000;
		if(this.isDemo) {
			// we want to pick a random league that's not blacklisted
			// and tweet from it occasionally.
			var legalLeagueIds = _.filter(Object.keys(this.leagues), _.bind(function(id) {
				return !_.contains(this.blacklistedLeagueIds, id);
			}, this));

			winston.info(JSON.stringify(legalLeagueIds));

			this.updater = setInterval(_.bind(function() {
				var rand = Math.floor(Math.random()*legalLeagueIds.length);

				var leagueId = legalLeagueIds[rand];

				winston.info("Demoing: " + leagueId);

				this.leagues[leagueId].demo = true;
				this.leagues[leagueId].lastSeenMatchIds = [];

				this.getRecentLeagueMatches(leagueId);
			}, this), 5000);
		} else {
			// now kick off a periodic live games update.
			this.updater = setInterval(_.bind(function() {
				this.checkForLiveLeagueGames();

				// once a day, do a full leaguelisting update
				var now = new Date().getTime();
				if(now - this.lastLeagueUpdate > (24*60*60*1000)) {
					this.updateLeagueListing();
					this.updateTeamListing();
				}
			}, this), duration);
		}
	},

	stop: function() {
		winston.info("STOP ResultsServer");

		clearInterval(this.updater);
	},

	destroy: function() {
		winston.info("DESTROY ResultsServer");
	},

	logRecentMatch: function(match,league) {
		// first, check it against the league listing.
		if(_.contains(league.lastSeenMatchIds, match.match_id)) {
			// winston.info("Match_id (" + match.match_id + ") is lower than last logged: " + league.mostRecentMatchId);
			return;
		} else {
			winston.info("Found new match_id: " + match.match_id);
			league.lastSeenMatchIds.push(match.match_id);


			// if we're still in init mode, don't tweet.
			if(!league.init) {
				// keep track of match ids that we want to tweet, and if they don't
				// get successfully processed (ie the get match details call fails, which
				// happens a distressing amount of the time) then try again later.
				this.matchIdsToTweet.push(match.match_id);

				this.processFinishedMatch(match.match_id);
			} else if(league.demo) {
				// tweet the first thing we encounter just to test, then bail.
				this.processFinishedMatch(match.match_id);
			}
		}
	},

	updateTeamListing: function() {
		winston.info("Updating team listing.");

		this.api().getTeamInfoByTeamID({}, _.bind(function(err, res) {
			if(err) {
				winston.error("Error loading team listing: " + err);
				return;
			}

			_.each(res.teams, _.bind(function(team) {
				// skip any team that hasn't appeared in a league game.
				if(!"league_id_0" in team) {
					return;
				}

				this.teams[team.team_id] = team;
			}, this));

			this.saveTeams();

			winston.info("Loaded " + Object.keys(this.teams).length + " teams.");
		}, this));
	},

	updateLeagueListing: function() {
		winston.info("Updating league listing.");
		this.api().getLeagueListing(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading league listing: " + err);
				return;
			}

			var that = this;
			this.leagues = {};
			_.each(res.leagues, function(league) {
				if(league.leagueid in that.leagues) {
					var lastSeenMatchIds = that.leagues[league.leagueid].lastSeenMatchIds;
					league.lastSeenMatchIds = lastSeenMatchIds;
				}

				that.leagues[league.leagueid] = league;
			});

			winston.info("Loaded " + Object.keys(this.leagues).length + " leagues.");

			this.lastLeagueUpdate = new Date().getTime();

			this.emit("leagues:update");
			this.saveLeagues();
		}, this));
	},

	saveLeagues: function() {
		fs.writeFile("/tmp/leagues.json", JSON.stringify(this.leagues));
	},

	saveTeams: function() {
		fs.writeFile("/tmp/teams.json", JSON.stringify(this.teams));
	},

	checkForLiveLeagueGames: function() {
		// winston.info("Checking for live games.");
		this.api().getLiveLeagueGames(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading live league games: " + err);
				return;
			}

			if(_.isUndefined(res)) {
				winston.warn("No live games found.");
				res = {games:[]};
				return;
			}

			this.liveGames = res.games;
			this.lastLiveGamesUpdate = new Date().getTime();

			// winston.info("Found " + this.liveGames.length + " active league games.");

			this.emit("live-games:update");
		}, this));
	},

	getLeaguesWithLiveGames: function() {
		var leagueIds = _.map(this.liveGames, _.bind(function(game) {
			return game.league_id;
		}, this));


		return _.uniq(leagueIds);
	},

	getRecentLeagueMatches: function(leagueId, cb) {
		var league = this.leagues[leagueId];

		// only look for games in the last few days
		var date_min = (new Date().getTime()) - 60*60*24*1*1000;

		if(this.isDemo) {
			date_min = (new Date().getTime()) - 60*60*24*365*1000;
		}

		winston.debug("Getting most recent matches for " + league.name);
		this.api().getMatchHistory({
			league_id: leagueId,
			date_min: Math.floor(date_min/1000)
		}, _.bind(function(err, res) {
			if(err) {
				winston.error("error loading matches: " + err);
				return;
			}

			if(res.total_results == 0) {
				winston.warn("No matches returned for league_id: " + league.name);
				return;
			} else {
				// winston.info(res.matches.length + " matches found for " + league.name);
			}
			
			if(this.isDemo) {
				res.matches = _.first(res.matches, 2);
			}

			_.each(res.matches, _.bind(function(match) {
				this.logRecentMatch(match, this.leagues[leagueId]);
			}, this));

			this.leagues[leagueId].init = false;

			// run the callback if present.
			cb && cb(res.matches);
		}, this));
	},

	processFinishedMatch: function(matchId) {
		winston.info("Loading match to tweet: " + matchId);
		this.api().getMatchDetails(matchId, _.bind(function(err, match) {
			if(err) {
				winston.error("error loading match: " + err);
				return;
			}

			var teams = [];
			_.each(["radiant", "dire"], function(name) {
				var team = {};
				_.each(["name", "team_id", "logo", "team_complete"], function(param) {
					team[param] = match[name+"_"+param];
				});
				team["side"] = name;

				team.kills = 0;

				teams.push(team);
			});

			_.each(match.players, function(player) {
				var index = 0;
				if(player.player_slot >= 128) index = 1;

				teams[index].kills += player.kills;
			});

			if(_.isUndefined(teams[0].name) || _.isUndefined(teams[1].name)) {
				winston.warn("Found team with undefined name. Probably a pickup league, ignoring.");
				return;
			}

			if(match.radiant_win) {
				teams[0].winner = true;
				teams[1].winner = false;

				teams[0].displayName = "[" + teams[0].name + "]";
				teams[1].displayName = teams[1].name;
			} else {
				teams[0].winner = false;
				teams[1].winner = true;

				teams[0].displayName = teams[0].name;
				teams[1].displayName = "[" + teams[1].name + "]";
			}

			var durationString = " " + Math.floor(match.duration/60) + "m";

			if(match.duration%60<10) {
				durationString += "0" + match.duration%60;
			} else {
				durationString += match.duration%60;
			}

			durationString += "s";

			var league = this.leagues[match.leagueid];

			// winston.info("Processing match between " + teams[0].name + " and " + teams[1].name);

			var tweetString =  teams[0].displayName + " " + teams[0].kills + "\u2014" + teams[1].kills + " " + teams[1].displayName + "\n" + durationString + " // " +league.name + "   \n" + "http://dotabuff.com/matches/" + matchId;

			if((teams[0].kills + teams[1].kills)==0 && match.duration <= 360) {
				winston.info("Discarding match with 0 kills and 6 minute duration.");
				return;
			}

			if(tweetString.length > 140) {
				tweetString = tweetString.substring(0, 139);
			}

			var isBlacklisted = _.contains(this.blacklistedLeagueIds, match.leagueid);

			if(!isBlacklisted) {
				winston.info("TWEET: " + tweetString);
				this.tweet(tweetString);
			} else {
				winston.info("TWEET.ALT: " + tweetString);
				this.altTweet(tweetString);
			}

			// now remove the match_id from matchIdsToTweet
			this.matchIdsToTweet = _.without(this.matchIdsToTweet, [matchId]);
			winston.info("Removing match id after successful tweet: " + matchId);
		}, this));
	},

	// should really abstract this properly but I'm lazy right now and
	// don't want to deal with the throttle function and arguments.
	_altTweet: function(string) {
		if(this.isDemo) return;

		// this.twitterAlt.post('statuses/update', { status: string }, function(err, reply) {
		// 		if (err) {
	 //  				winston.error("Error posting tweet: " + err);
		// 		} else {
	 //  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
		// 		}
  // 		});
	},

	_tweet: function(string) {
		if(this.isDemo) return;

		// this.twitter.post('statuses/update', { status: string }, function(err, reply) {
		// 		if (err) {
	 //  				winston.error("Error posting tweet: " + err);
		// 		} else {
	 //  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
		// 		}
  // 		});
	},

	api: function() {
		return new dazzle(process.env.STEAM_API_KEY);
	}
};

_.extend(exports.ResultsServer.prototype, EventEmitter.prototype);



/////////////////////////////////////////////////////
//					STARTUP 					   //
/////////////////////////////////////////////////////

var server = new exports.ResultsServer();

// this is really super duper fragile
var isDemo = process.argv[2]=="demo";

winston.info("demo: " + isDemo);

server.init(isDemo);
server.start();


process.on('uncaughtException', function(err) {
  winston.error(err.stack);
});


