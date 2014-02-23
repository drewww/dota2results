var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	EventEmitter = require('events').EventEmitter,
	fs = require('fs'),
	twit = require('twit');

if("REDISCLOUD_URL" in process.env) {
	var redis = require('redis'),
		url = require('url');
}

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

	activeSeriesIds: null,

	starting: true,

	updater: null,

	activeLeagueIds: null,

	blacklistedLeagueIds: null,

	isDemo: false,

	matchesToTweet: null,

	redis: null,

	init: function(isDemo, isSilent) {
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

		this.matchesToTweet = [];

		// activeSeriesIds tracks the win/loss patterns in currently-active
		// series (ie bo3, bo5, etc)
		// individual games don't return this information, but the match_history
		// listings tell us whether a match is part of a series and how long
		// that series should be. If we see a series_id that's new, we'll
		// add it here (key=>series_id) and whenever we see a win/loss for that
		// series_id we'll update it. We'll identify teams within the record with
		// another {} with the keys as team_ids and the values as wins.
		//
		// we'll clean these out when we've seen enough wins (ie 2 for a bo3, 3 for a bo5)
		// OR when we haven't updated the entry for three days. This should only
		// really happen if we start this mid-series for anything. But it's important to 
		// avoid a memory leak.
		this.activeSeriesIds = {};

		// auto-discard any super rapid tweets
		// this will cull some of the potential horror of auto tweeting
		// every result in the list. Might also catch legit multiple games
		// ending in rapid succession; i'm not sure yet.
		this.tweet = _.throttle(this._tweet, 500);
		this.altTweet = _.throttle(this._altTweet, 500);

		this.blacklistedLeagueIds = JSON.parse(process.env.BLACKLISTED_LEAGUE_IDS);

		this.isDemo = isDemo;
		this.isSilent = isSilent;

		if("REDISCLOUD_URL" in process.env) {
			var redisURL = url.parse(process.env.REDISCLOUD_URL);
			this.redis = redis.createClient(redisURL.port, redisURL.hostname, {no_ready_check: true});
client.auth(redisURL.auth.split(":")[1]);

			this.redis.on("connect", _.bind(function() {
				winston.info("Connected to redis!");
				this.loadSeries();
			}, this));
		} else {
			winston.warn("Redis connection information not available.");
			this.loadSeries();
		}
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

			if(this.matchesToTweet.length > 0) {
				winston.info(this.matchesToTweet.length + " queued matches that haven't been successfully tweeted, retrying now: " + JSON.stringify(this.matchIdsToTweet));
				_.each(this.matchesToTweet, _.bind(function(match) {
					this.processFinishedMatch(match);
				}, this));
			}
		}, this));

		if(Object.keys(this.leagues).length==0) {
			this.updateLeagueListing();
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
			league.lastSeenMatchIds.push(match.match_id);

			// if we're still in init mode, don't tweet.
			if(!league.init) {
				// keep track of match ids that we want to tweet, and if they don't
				// get successfully processed (ie the get match details call fails, which
				// happens a distressing amount of the time) then try again later.
				this.matchesToTweet.push(match);

				this.processFinishedMatch(match);
			} else if(league.demo) {
				// tweet the first thing we encounter just to test, then bail.
				this.processFinishedMatch(match);
			}
		}
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

	saveSeries: function() {
		if(this.redis) {
			this.redis.set("global:series", JSON.stringify(this.activeSeriesIds));
		} else {
			fs.writeFile("/tmp/series.json", JSON.stringify(this.activeSeriesIds));
		}
	},

	loadSeries: function() {
		if(this.redis) {
			this.redis.get("global:series", function(err, reply) {
				if(!err) {
					this.activeSeriesIds = JSON.parse(reply);
					winston.info("Loading series from cache: " + JSON.stringify(this.activeSeriesIds));
				} else {
					winston.warn("Error loading series from cache: " + err + "; defaulting to empty.");
					this.activeSeriesIds = {};
				}
			});
		} else {
			try {
				this.activeSeriesIds = JSON.parse(fs.readFileSync("/tmp/series.json", {encoding:"utf8"}));
			} catch (e) {
				winston.warn("Error loading series from disk, defaulting to empty.");
				this.activeSeriesIds = {};
			}

			winston.info("Loaded series from disk: " + JSON.stringify(this.activeSeriesIds));
		}
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

		// only look for games in the last 7 days
		// (widening this window since if there aren't games in that
		//  period sometimes we miss the first game for a tournament in 
		//	that window.)
		var date_min = (new Date().getTime()) - 60*60*24*7*1000;

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

	processFinishedMatch: function(matchMetadata) {
		winston.info("Loading match to tweet: " + matchMetadata.match_id);
		this.api().getMatchDetails(matchMetadata.match_id, _.bind(function(err, match) {
			if(err) {
				winston.error("error loading match: " + err);
				// in this case we DON'T pull it from the queue; we want to retry
				// these. But any other type of error we want to toss it.
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

			// this is a little unusual; instead of counting kills and crediting the
			// to the team with the kills, we're changing to count DEATHS of the opposite 
			// team and attribute that score to the opposite team. This difference matters
			// in situations with suicides and neutral denies. This matches the behavior
			// of the in-game scoreboard, even though it's sort of idiosyncratic.
			// Thanks to @datdota for pointing out this inconsistency.
			_.each(match.players, function(player) {
				var index = 1;
				if(player.player_slot >= 128) index = 0;

				teams[index].kills += player.deaths;
			});

			if(_.isUndefined(teams[0].name) || _.isUndefined(teams[1].name)) {
				winston.warn("Found team with undefined name. Probably a pickup league, ignoring.");
				this.removeMatchFromQueue(match);
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

			// now, lets update the series_id information.
			// first, check and see if this series has been seen before.
			
			if(matchMetadata.series_type > 0) {
				winston.debug(JSON.stringify(this.activeSeriesIds));

				var seriesStatus;
				if(matchMetadata.series_id in this.activeSeriesIds) {
					seriesStatus = this.activeSeriesIds[matchMetadata.series_id]
				} else {
					seriesStatus = {
						series_id: matchMetadata.series_id,
						series_type: matchMetadata.series_type,
						teams: {},
						time: new Date().getTime()
					}

					seriesStatus.teams[teams[0]["team_id"]] = 0;
					seriesStatus.teams[teams[1]["team_id"]] = 0;
				}

				// now update the results based on who won
				var teamId = teams[0]["team_id"];
				
				if(teams[1].winner) {
					teamId = teams[1]["team_id"];
				}

				seriesStatus.teams[teamId] = seriesStatus.teams[teamId]+1;
				seriesStatus.time = new Date().getTime();

				// construct a string where it has filled in circles for every
				// win, and empty circles to fill into the total number of games
				// necessary.

				_.each([0, 1], function(index) {
					teams[index].series_wins = seriesStatus.teams[teams[index]["team_id"]]

					var winString = "";					
					for(var x=0; x<teams[index].series_wins; x++) {
						winString = winString + "\u25CF";
					}

					// at this point we have as many dots as this team has wins.
					// now, fill up the remainder.
					var gamesToWin = seriesStatus.series_type+1;
					var emptyDots = gamesToWin - teams[index].series_wins;

					// flip the direction the empty dots are on, so wins are always
					// closest to the team name.
					if(index==0) {
						for (var o=0; o<emptyDots; o++) {
							winString = "\u25CC" + winString;
						}
					} else {
						for (var o=0; o<emptyDots; o++) {
							winString = winString + "\u25CC";
						}
					}

					// store it for later.
					teams[index].wins_string = winString;
				});

				// move the information into the teams objects for convenience
				teams[0].series_wins = seriesStatus.teams[teams[0]["team_id"]]
				teams[1].series_wins = seriesStatus.teams[teams[1]["team_id"]]
				winston.debug("Series win info: " + teams[0].series_wins + " - " + teams[1].series_wins);
			} else {
				teams[0].series_wins = null;
				teams[1].series_wins = null;
				teams[0].wins_string = "";
				teams[1].wins_string = "";
				winston.debug("No series data available.");
			}

			// now push the series status into 

			var durationString = " " + Math.floor(match.duration/60) + "m";

			if(match.duration%60<10) {
				durationString += "0" + match.duration%60;
			} else {
				durationString += match.duration%60;
			}

			durationString += "s";

			var league = this.leagues[match.leagueid];

			var tweetString = teams[0].wins_string + " " + teams[0].displayName + " " + teams[0].kills + "\u2014" + teams[1].kills + " " + teams[1].displayName + " " + teams[1].wins_string + "\n";
			tweetString = tweetString + durationString + " // " +league.name + "   \n";
			tweetString = tweetString + "http://dotabuff.com/matches/" + matchMetadata.match_id;

			if((teams[0].kills + teams[1].kills)==0 || match.duration <= 410) {
				winston.info("Discarding match with 0 kills and 6 minute duration.");
				this.removeMatchFromQueue(match);
				return;
			}

			if(tweetString.length > 140) {
				tweetString = tweetString.substring(0, 139);
			}

			var isBlacklisted = _.contains(this.blacklistedLeagueIds, match.leagueid);

			if(!isBlacklisted) {
				winston.info("TWEET: " + tweetString);
				this.tweet(tweetString, matchMetadata);
			} else {
				winston.info("TWEET.ALT: " + tweetString);
				this.altTweet(tweetString, matchMetadata);
			}

			// now remove the match_id from matchIdsToTweet
			winston.info("Removing match id after successful tweet: " + matchMetadata.match_id);
			this.removeMatchFromQueue(matchMetadata.match_id);

			// update the listing if there were series wins.
			// do this late in the process in case there were errors.
			if(!_.isNull(teams[0].series_wins)) {
				this.activeSeriesIds[seriesStatus.series_id] = seriesStatus;

				// cache the series data so it survives a restart. 
				this.saveSeries();
			}
			this.cleanupActiveSeries();
		}, this));
	},

	cleanupActiveSeries: function() {
		// run through all active series. 
		var idsToRemove = [];
		var now = new Date().getTime();
		_.each(this.activeSeriesIds, function(series, id) {
			if((now - series.time) > 60*60*12*1000) {
				idsToRemove.push(series.series_id);
				winston.info("Removing series_id due to age: " + series.series_id);
			}

			var maxGames = 0;
			_.each(series.teams, function(wins, team_id) {
				maxGames = Math.max(maxGames, wins);
			});

			// series_type is 1 for a bo3, 2 for a bo5, (3 for a bo7?)
			// so just do that number +1 because that's the number of matches
			// it would take to win.
			if(maxGames==(series.series_type+1)) {
				idsToRemove.push(series.series_id);
				winston.info("Removing series_id due to max games hit " + series.series_id);
			}
		});

		_.each(idsToRemove, _.bind(function(id) {
			delete this.activeSeriesIds[id];
		}, this));

		winston.info("After cleaning, # series being tracked: " + Object.keys(this.activeSeriesIds).length);
	},

	// should really abstract this properly but I'm lazy right now and
	// don't want to deal with the throttle function and arguments.
	_altTweet: function(string, match) {
		if(this.isDemo) return;
		if(this.isSilent) return;

		this.twitterAlt.post('statuses/update', { status: string }, function(err, reply) {
				if (err) {
	  				winston.error("Error posting tweet: " + err);

	  				if(err.message.indexOf('duplicate')!=-1 || err.message.indexOf('update limit')!=-1) {
	  					winston.info("Error posting, duplicate or over limit - drop.");
	  					this.removeMatchFromQueue(match);
	  				}
				} else {
	  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
				}
  		});
	},

	_tweet: function(string, match) {
		if(this.isDemo) return;
		if(this.isSilent) return;

		this.twitter.post('statuses/update', { status: string }, function(err, reply) {
				if (err) {
	  				winston.error("Error posting tweet: " + err);

	  				if(err.message.indexOf('duplicate')!=-1 || err.message.indexOf('update limit')!=-1) {
	  					winston.info("Error posting, duplicate or over limit - drop.");
	  					this.removeMatchFromQueue(match);
	  				}
				} else {
	  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
				}
  		});
	},

	removeMatchFromQueue: function(match) {
		this.matchesToTweet = _.reject(this.matchesToTweet, function(match) {
			return match.match_id==match.match_id;
		});
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
var isSilent = process.argv[2]=="silent";


winston.info("demo: " + isDemo);
winston.info("silent: " + isSilent);

server.init(isDemo, isSilent);
server.start();


process.on('uncaughtException', function(err) {
  winston.error(err.stack);
});


