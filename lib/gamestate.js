var winston = require('winston'),
	boxscores = require('./boxscores.js'),
	draft = require('./draft.js'),
	request = require('request'),
	fs = require('fs'),
	async = require('async'),
	EventEmitter = require('events').EventEmitter,
	team_twitter = require('./twitter_handles.js').teams,
	_ = require('underscore')._;

function GameStateTracker(redis, silent) {
	this.lobbies = {};
	this.redis = redis;
	this.lobbiesThisTick = [];
	this.isSilent = silent;

	// TODO get a link to the proper twitter object here, and use the
	// mainline twitter media posting methods rather than the
	// old style media custom posting method.

	// load lobbies out of redis
	// we could just shove it all into one key, but that's
	// a little gross. Lets be a little more civilized and do it per key.
	this.redis.keys("lobby:*", _.bind(function(err, reply) {
		_.each(reply, _.bind(function(key) {
			this.redis.get(key, _.bind(function(err, reply) {
				// load it in.
				var lobbyId = key.split(":")[1];
				this.lobbies[lobbyId] = JSON.parse(reply);
				winston.info("loading in: " + lobbyId + " goldTicks: " + this.lobbies[lobbyId].goldHistory.length + " events: " + this.lobbies[lobbyId].events.length);
			}, this));
		}, this));
		winston.info("Done loading, found " + reply.length + " lobby entries.");
	}, this));

	// load cached player names
	this.playerNames = {};
	this.redis.get("global:playerNames", _.bind(function(err, reply) {
		if(!_.isNull(reply)) {
			this.playerNames = JSON.parse(reply);
			winston.info("Loaded " + Object.keys(this.playerNames).length + " player name mappings.");
		} else {
			winston.warn("Issue loading player name mappings: " + err);
		}
	}, this));

	winston.info("Constructed game state tracker.");
}

// the primary internal data structure here is the lobbies object
// it maps lobbyId keys to an object that contains a few pieces
// of info:
//	- lastTimestamp
//	- lastSnapshot
//	- goldHistory: list of {timestamp, radiantGold, direGold, diff} objects
//	- events: list of {event_type, timestamp, team, ...} (include other random metadata)

GameStateTracker.prototype = {
	lobbies: null,

	lobbiesThisTick: null,

	processSnapshot: function(snapshot) {
		// winston.info("processing snapshot for " + snapshot.match_id + " " + snapshot.scoreboard.duration);

		var lobby;
		var lobbyId = snapshot.lobby_id;

		this.lobbiesThisTick.push(lobbyId);

		if(lobbyId in this.lobbies) {
			lobby = this.lobbies[lobbyId];
			// winston.debug("Found existing lobby for " + lobbyId);

			// check about the time gap between snapshots
			// there's potentially an issue when there's a big gap
			if((snapshot.scoreboard.duration - lobby.lastTimestamp) > 60) {
				// winston.debug("More than 60 seconds gap in snapshots for " + lobbyId);				
			}

			if(snapshot.scoreboard.duration==lobby.lastTimestamp) {
				// winston.debug("Duplicate snapshot detected in lobby " + lobbyId + " for time " + lobby.lastTimestamp);

				// just skip it, nbd.
				// since snapshots seem to only update every 1-2 minutes,
				// this is going to happen a lot.
				return;
			}

			if(lobby.lastTimestamp==0) {
				// implicitly, the last check would have caught another 0. 
				// so if last was 0 and we're here, this is the first non-zero
				// tick for a game. 
				winston.info("Game started for real: " + lobbyId);
			}

			// winston.info("processing new snapshot for " + lobbyId);

			// extract new gold data from this snapshot
			lobby.goldHistory.push(this.handleGold(lobby, snapshot));

			// extract events (this is tower kills and barracks kills)
			_.each(this.handleEvents(lobby, snapshot), _.bind(function(event) {
				lobby.events.push(event);
			}, this));

			// do some accounting
			lobby.lastSnapshot = snapshot;
			lobby.lastTimestamp = snapshot.scoreboard.duration;
			lobby.lastUpdate = Date.now();

			// okay the sad state of affairs here is that pick_ban info resides
			// only in the matchdetails request, not in the scoreboard that
			// we can see in liveleaguegames. This means that we can't get bans out
			// at all, but we CAN figure out which players are playing which heroes
			// by inspecting the scoreboard. It's possible that we never see
			// a scoreboard without these, but we'll tread carefully to make sure.
			// winston.info("checking to see if we should pull draft info: " + ("scoreboard" in snapshot) + "; " + lobby.draft_over);
			if("scoreboard" in snapshot && !lobby.draft_over) {

				// try to collect the info we need. it's in lobby:scoreboard:dire/radiant:players
				// as well as in lobby:players. There are some differences in what's available
				// in each location. Player names are only in the global list, but team/position
				// mappings are in the team specific lists.
				// first pass we'll just do the global list, later we'll order them by team order.
				try {
					var picks = {};
					_.each(["radiant", "dire"], function(team) {
						_.each(snapshot.scoreboard[team].players, function(player) {
							picks[player.account_id] = {"hero":player.hero_id, "team":team,
								"account_id":player.account_id};
						});
					});

					// now, look at the other place names come from. This will give us
					// in-game names. These are noisy and weird but will always be
					// present, even for minor players.
					_.each(snapshot.players, function(player) {
						if(player.account_id in picks) {
							picks[player.account_id].name = player.name;
						}
					});

					// now, we want player names in their canonical forms. 
					// otherwise, the names are really just all over the place.
					// that query looks like this: 

					// and results are like this:
					// {
					// 	"result": {
					// 		"Name": "Dendi",
					// 		"TeamName": "Natus Vincere",
					// 		"TeamTag": "Na`Vi",
					// 		"Sponsor": "",
					// 		"FantasyRole": 1
					// 	}
					// }
					// if they have no entry, it looks like this:
					//
					// {
					// 	"result": {
					// 		"Name": ""
					// 	}
					// }
					//
					// we can get these from this api call:
					// https://api.steampowered.com/IDOTA2Fantasy_570/GetPlayerOfficialInfo/v1/?key=[KEY]&AccountID=70388657
					//
					// This is obviously somewhat expensive; a request for every single player
					// is sort of overkill. So, first check the cache in this.playerNames.

					async.parallel(_.map(picks, _.bind(function(pick) {
						// return a function that handles this pick/player
						return _.bind(function(callback) {
							if(pick.account_id in this.playerNames) {
								winston.debug("Found player name in cache: " + this.playerNames[pick.account_id] + " for id " + pick.account_id);
								callback(null, [pick.account_id, this.playerNames[pick.account_id]]);
							} else {
								// go find it.
								winston.debug("Requesting real player name for " + pick.account_id);
								request("https://api.steampowered.com/IDOTA2Fantasy_570/GetPlayerOfficialInfo/v1/?key=" + 
									process.env.STEAM_API_KEY + "&AccountID=" + pick.account_id, 
									_.bind(function(err, response, body) {
										var result = JSON.parse(body);
										if("result" in result) {
											if (result.result.Name.length > 0) {

												// cache the name in playernames.
												this.playerNames[pick.account_id] = result.result.Name;
												callback(null, [pick.account_id, result.result.Name]);
											} else {
												callback(null, [pick.account_id, ""]);	
											}
										} else {
											callback(null, [pick.account_id, ""]);
										}
									}, this));
							}
						}, this);
					}, this)), _.bind(function(err, results) {

						// TODO some sort of mapping of the results tuples into
						// the normal picks structure. 
						_.each(results, function(tuple) {
							account_id = tuple[0];
							name = tuple[1];

							if(name.length > 0) {
								// look up the id in the list and swap in the canonical name
								if(account_id in picks) {
									picks[account_id].name = name;
									winston.debug("replacing name with looked-up name: " + name);
								}
							}
						});

						winston.info("Updating playerNames cache in redis.");
						this.redis.set("global:playerNames", JSON.stringify(this.playerNames));

						lobby.draft_over = true;
						lobby.picks = picks;
						winston.info("DRAFT OVER FOR LOBBY " + lobbyId);
						winston.info(JSON.stringify(lobby.picks));
						if(lobby.lastSnapshot.league_id==2733 && !this.isSilent) {

							// TODO transition this over to the new generation style that
							// handles it in memory rather than hitting disk. This will
							// definitely not tweet as written (since twitter_update_with_media is deprecated)
							// but also still depends on writing to disk and reading from disk.
							draft.generate(lobby, _.bind(function(filename) {
								winston.info("Done generating file: " + filename);
								winston.info("Time to tweet this: " + lobby.lastSnapshot.league_id);

								// only tweet if it's league 2733, eg ti.

									// try to do a media tweet. If we don't pull it off,
									// don't tweet at all since we can't really fit all the
									// hero names. We want to get the team names/ids in though.
									// so here's the template:
									//
									// Team A versus Team B is now live! picture_link
									// (we'll try to get a steam spectator link in next)
									var teams = [];

									var message = "";

									_.each(["radiant", "dire"], function(team) {
										var teamId = lobby.lastSnapshot[team + "_team"].team_id;
										var teamName = lobby.lastSnapshot[team + "_team"].team_name;

										if(teamId in team_twitter) {
											teamName = "@" + team_twitter[teamId];
										}

										teams.push({team_id:teamId, team_name:teamName});
									});

									message = teams[0].team_name + " versus " + teams[1].team_name + " is now live!";

									if(message[0]=="@") {
										message = "." + message;
									}

									// now try to media tweet this.
									// TODO rework this to use the new media posting strategy.
									// this.twitterMedia.post(message, "/tmp/" + filename, _.bind(function(err, response, body) {
									// 		winston.info("post twitter DRAFT media: " + err + "; " + response.statusCode);							
									// }, this));
									winston.error("NOT POSTING DRAFT IMAGE BEACUSE IT USES OLD TWITTER MEDIA STYLE");
							}, this));
						}
					}, this));
				} catch (e) {
					winston.warn("Issue extracting pick data:" + e);
				}
			}
			// we may not need these but storing for now.
		} else {
			if(_.isUndefined(snapshot.scoreboard)) {
				winston.warn("Found undefined scoreboard for lobby " + lobbyId);
				return;
			}

			lobby = {
				lastTimestamp: snapshot.scoreboard.duration,
				lastSnapshot: snapshot,
				goldHistory: [],
				events: [],
				finished: false,
				draft_over: false
			};

			winston.info("Creating a new lobby entry for an unseen lobby.");
		}

		this.lobbies[lobbyId] = lobby;
		// cache it to redis
		this.redis.set("lobby:" + lobbyId, JSON.stringify(lobby));

		// let these keys expire 60 minutes after their last update.
		// this will keep things from getting too out of hand. 
		this.redis.expire("lobby:" + lobbyId, 60*60);
	},

	finish: function() {
		// look for lobbyIds that we didn't see updates for in this last cycle.
		// those are probably games that have ended.

		var lobbiesTracked = Object.keys(this.lobbies);
		winston.debug("tracked: " + lobbiesTracked.length + " (this tick " + this.lobbiesThisTick.length + ")");

		// start with the list of all lobbies tracked. Remove any
		// lobby we saw this tick. The remaining ids are lobbies
		// that have probably closed.

		// filter out finished lobbies
		var lobbiesMissed = _.filter(lobbiesTracked, _.bind(function(lobby) {
			return !(this.lobbies[lobby].finished);
		}, this));

		_.each(this.lobbiesThisTick, function(lobbyId) {
			// winston.info("lobbyId: " + JSON.stringify(lobbyId) + " in " + JSON.stringify(lobbiesMissed));
			lobbiesMissed = _.without(lobbiesMissed, lobbyId + "");
		});

		this.lobbiesThisTick = [];


		if(lobbiesMissed.length > 0) {
			// winston.info("MISSED LOBBY IDS: " + JSON.stringify(lobbiesMissed));
			_.each(lobbiesMissed, _.bind(function(lobbyId) {
				// extract some summary info
				// we want to know:
				//	which teams are playing
				//	which league
				//	which heroes
				var finishedGameLobby = this.lobbies[lobbyId];

				var teams = {};
				_.each(["radiant", "dire"], function(team) {
					var info = finishedGameLobby.lastSnapshot[team + "_team"];

					if(_.isUndefined(info)) {
						// not sure why this is happening.
						// I don't think this is totally game-breaking; i'm not even sure
						// we use this information at all, since detecting finished matches
						// is sort of not-critical at this point.
						winston.info("found undefined info for " + team + " in lobby " + lobbyId);
						return;
					}

					// now add in hero info
					var players = finishedGameLobby.lastSnapshot.scoreboard[team].players;
					var heroes = [];
					_.each(players, function(player) {
						heroes.push(player.hero_id);
					});
					info.heroes = heroes;
					teams[team] = info;
				});

				finishedGameLobby.teams = teams;
				finishedGameLobby.lobby_id = lobbyId;

				winston.info("GAME OVER: " + JSON.stringify(teams));
				// at this point we mark the lobby as a game over lobby
				// and hold onto it.

				winston.info("emitting game-over for match id "+
					finishedGameLobby.lastSnapshot.match_id + " in league " + finishedGameLobby.lastSnapshot.league_id);
				this.emit("game-over", finishedGameLobby.lastSnapshot.match_id, finishedGameLobby.lastSnapshot.league_id);

				finishedGameLobby.finished = true;

				this.lobbies[lobbyId] = finishedGameLobby;
				// fs.writeFileSync("games/lobby_" + lobbyId + ".json", JSON.stringify(finishedGameLobby));
				// boxscores.generate(finishedGameLobby);

				// stop deleting game states for now. we only want to delete
				// after we've done a generate operation, which we need to 
				// delay until we get the actual game info.
				// winston.info("Deleting: " + lobbyId);
				// delete this.lobbies[lobbyId];
			}, this));
		}
	},

	// returns a list of new events.
	handleEvents: function(lobby, snapshot) {
		// we're looking for changes in:
		//	tower state
		//	kills (eh, skip this for now)
		//	roshan (eventually; might be challenging to detect in 60s increments)
		//  ?? items?

		var events = [];

		// if radiant/dire are undefined the game hasn't started yet and we
		// can skip this section. If we don't skip it, we'll get a bunch of
		// undefined access errors.

		// for the sake of making this easy, lets just squish the two masks
		// together and leave the rest of the logic unchanged. 
		var combinedPreviousTowerState = lobby.lastSnapshot.scoreboard.radiant.tower_state + 
			(lobby.lastSnapshot.scoreboard.dire.tower_state << 11);
		var combinedNewTowerState = snapshot.scoreboard.radiant.tower_state + 
			(snapshot.scoreboard.dire.tower_state << 11);

		if((lobby.lastSnapshot.scoreboard) && 
			(combinedPreviousTowerState != combinedNewTowerState))
		 {

			// this is the way the bits are used for tower state. I think left-most
			// edge of this is the MSB, so if I shift these off one at a time
			// I'll basically move from the bottom of this list to the top.
			// 
		    // ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬───────────────────────────────────────────── Not used.
		    // │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────────────── Dire Ancient Top
		    // │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────────────── Dire Ancient Bottom
		    // │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────────── Dire Bottom Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────────── Dire Bottom Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────── Dire Bottom Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────── Dire Middle Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────── Dire Middle Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────── Dire Middle Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────── Dire Top Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────── Dire Top Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────── Dire Top Tier 1 
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────── Radiant Ancient Top
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────── Radiant Ancient Bottom
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────── Radiant Bottom Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────── Radiant Bottom Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────── Radiant Bottom Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────── Radiant Middle Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────── Radiant Middle Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────── Radiant Middle Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───── Radiant Top Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─── Radiant Top Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─ Radiant Top Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │
		    // 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0

		    var towerTypes = [
		    	{type: "tower", team:"radiant", tier: 1, lane: "top", mask: Math.pow(2, 0)},
		    	{type: "tower", team:"radiant", tier: 2, lane: "top", mask: Math.pow(2, 1)},
		    	{type: "tower", team:"radiant", tier: 3, lane: "top", mask: Math.pow(2, 2)},
		    	{type: "tower", team:"radiant", tier: 1, lane: "mid", mask: Math.pow(2, 3)},
		    	{type: "tower", team:"radiant", tier: 2, lane: "mid", mask: Math.pow(2, 4)},
		    	{type: "tower", team:"radiant", tier: 3, lane: "mid", mask: Math.pow(2, 5)},
		    	{type: "tower", team:"radiant", tier: 1, lane: "bot", mask: Math.pow(2, 6)},
		    	{type: "tower", team:"radiant", tier: 2, lane: "bot", mask: Math.pow(2, 7)},
		    	{type: "tower", team:"radiant", tier: 3, lane: "bot", mask: Math.pow(2, 8)},
		    	{type: "tower", team:"radiant", tier: 4, lane: "bot", mask: Math.pow(2, 9)},
		    	{type: "tower", team:"radiant", tier: 4, lane: "top", mask: Math.pow(2, 10)},
		    	{type: "tower", team:"dire", tier: 1, lane: "top", mask: Math.pow(2, 11)},
		    	{type: "tower", team:"dire", tier: 2, lane: "top", mask: Math.pow(2, 12)},
		    	{type: "tower", team:"dire", tier: 3, lane: "top", mask: Math.pow(2, 13)},
		    	{type: "tower", team:"dire", tier: 1, lane: "mid", mask: Math.pow(2, 14)},
		    	{type: "tower", team:"dire", tier: 2, lane: "mid", mask: Math.pow(2, 15)},
		    	{type: "tower", team:"dire", tier: 3, lane: "mid", mask: Math.pow(2, 16)},
		    	{type: "tower", team:"dire", tier: 1, lane: "bot", mask: Math.pow(2, 17)},
		    	{type: "tower", team:"dire", tier: 2, lane: "bot", mask: Math.pow(2, 18)},
		    	{type: "tower", team:"dire", tier: 3, lane: "bot", mask: Math.pow(2, 19)},
		    	{type: "tower", team:"dire", tier: 4, lane: "bot", mask: Math.pow(2, 20)},
		    	{type: "tower", team:"dire", tier: 4, lane: "top", mask: Math.pow(2, 21)}
		    ];

		    // first, get just the bits that have changed, eg
		    //	0011010	- previous
		    //	0010010	- now
		    //		XOR
		    //	0001000 - only bits that are either in one or the other.
		    //			  technically this would turn up towers that went
		    //			  from 0 to 1, but that can't happen game-wise.

		    var towersChanged = combinedPreviousTowerState ^ combinedNewTowerState;

		    // loop through all potential towers.
		    // try masking each one.
		    _.each(towerTypes, function(tower) {
		    	if(towersChanged & tower.mask) {
		    		var e = _.clone(tower);
		    		e.time = snapshot.scoreboard.duration;
		    		events.push(e);
		    		winston.info("TOWER FELL: " + JSON.stringify(e) + " in  lobby: " + snapshot.lobby_id);
		    	}
		    });
		}

		// now lets look for rax events
		// require that scoreboard exist and that there be some change
		// in the rax states.
		if((lobby.lastSnapshot.scoreboard) &&
			(lobby.lastSnapshot.scoreboard.radiant.barracks_state != 
				snapshot.scoreboard.radiant.barracks_state) ||
			(lobby.lastSnapshot.scoreboard.radiant.barracks_state != 
				snapshot.scoreboard.radiant.barracks_state)
			) {

			var raxTypes = [
				{type: "barracks", team:"radiant", lane: "top", kind: "melee", mask: Math.pow(2, 0)},
				{type: "barracks", team:"radiant", lane: "top", kind: "ranged", mask: Math.pow(2, 1)},
				{type: "barracks", team:"radiant", lane: "mid", kind: "melee", mask: Math.pow(2, 2)},
				{type: "barracks", team:"radiant", lane: "mid", kind: "ranged", mask: Math.pow(2, 3)},
				{type: "barracks", team:"radiant", lane: "bot", kind: "melee", mask: Math.pow(2, 4)},
				{type: "barracks", team:"radiant", lane: "bot", kind: "ranged", mask: Math.pow(2, 5)},
				{type: "barracks", team:"dire", lane: "top", kind: "melee", mask: Math.pow(2, 6)},
				{type: "barracks", team:"dire", lane: "top", kind: "ranged", mask: Math.pow(2, 7)},
				{type: "barracks", team:"dire", lane: "mid", kind: "melee", mask: Math.pow(2, 8)},
				{type: "barracks", team:"dire", lane: "mid", kind: "ranged", mask: Math.pow(2, 9)},
				{type: "barracks", team:"dire", lane: "bot", kind: "melee", mask: Math.pow(2, 10)},
				{type: "barracks", team:"dire", lane: "bot", kind: "ranged", mask: Math.pow(2, 11)}
			];

			// note that dire is 6->11 bits. We get them out of scoreboard as
			// 0-5 normally, but to just do this in one fell loop, lets 
			// cat the two together and put dire at the higher order bits.
			var combinedPreviousRaxState = lobby.lastSnapshot.scoreboard.radiant.barracks_state + 
				(lobby.lastSnapshot.scoreboard.dire.barracks_state << 6);
			var combinedNewRaxState = snapshot.scoreboard.radiant.barracks_state + 
				(snapshot.scoreboard.dire.barracks_state << 6);

			var raxChanged = combinedPreviousRaxState ^ combinedNewRaxState;

			_.each(raxTypes, function(rax) {
		    	if(raxChanged & rax.mask) {
		    		var e = _.clone(rax);
		    		e.time = snapshot.scoreboard.duration;
		    		events.push(e);
		    		winston.info("RAX FELL: " + JSON.stringify(e) + " in lobby: " + snapshot.lobby_id);
		    	}
		    });
		}

		return events;
	},

	// generates a single object that represents a gold snapshot
	handleGold: function(lobby, snapshot) {

		// first pass at this:
		// 	look at every player, multiply their GPM rate by the
		//	current timestamp to get the gold values.
		var gold = {};
		_.each(["radiant", "dire"], function(team) {
			var players = snapshot.scoreboard[team].players;

			var sumGold = 0;
			_.each(players, function(player) {
				sumGold+= player.net_worth;
			});

			gold[team] = sumGold;
		});

		return {time: snapshot.scoreboard.duration,
				radiantGold: gold.radiant,
				direGold: gold.dire,
				diff: (gold.radiant - gold.dire)};
	},

	// annoyingly, there's no clear way to link lobby ids back to game ids.
	// when the lobby closes we're missing critical info:
	// 	- who won?
	//	- what was the series status?
	//	- what is the game id for confirming against dotabuff or getting replays
	//	  or whatever else we might want?
	// there's also a timing issue here; I thiiiiink we get the GAME OVER event
	// before the MatchDeatails strategy updates, but we need to decouple these
	// events and link them up based on whoever comes second.
	getLobbyByTeamAndLeague: function(teams, leagueId) {

		winston.info("Looking up lobby by team + league: " + JSON.stringify(teams) + " in " + leagueId);

		if(_.isUndefined(teams[0]) || _.isUndefined(teams[1])) {
			winston.warn("Missing team data.")
			return false;
		}

		var lobby = _.find(this.lobbies, function(lobby) {
			if(leagueId==lobby.lastSnapshot.league_id) {
				// now look at teams
				// sometimes lobby.teams is undefined. I have no idea why,
				// but it seems like lastSnapshot.dire_team and .radiant_team
				// should work. So, we'll work with that instead.
				var radiantTeamId;
				var direTeamId;

				// make sure everything we need is defined. If any of it isn't, fall back to
				// information from the last snapshot.
				try {
					if(_.isUndefined(lobby.teams) ||
						_.isUndefined(lobby.teams.radiant) ||
						_.isUndefined(lobby.teams.dire)) {
						winston.info("\tno teams, fallback to snapshot");

						// old
						radiantTeamId = lobby.lastSnapshot.radiant_team.team_id;
						direTeamId = lobby.lastSnapshot.dire_team.team_id;
					} else {
						radiantTeamId = lobby.teams.radiant.team_id;
						direTeamId = lobby.teams.dire.team_id;					
					}
				} catch (e) {
					winston.error("Exception extracting team ids! " + e);
					// winston.error(JSON.stringify(lobby.teams))
					// winston.error(JSON.stringify(lobby.lastSnapshot.teams))
					return false;
				}

				if(_.contains(teams, radiantTeamId) && _.contains(teams, direTeamId)) {
					winston.info("found!");
					return true;
				}
			}
			return false;
		});


		var lobbiesToDelete = _.filter(this.lobbies, function(lobby) {
			return (Date.now() - lobby.lastUpdate) > (1000*60*60*3);
		});

		winston.info("removing " + lobbiesToDelete.length + " lobbies due to age")
		_.each(lobbiesToDelete, _.bind(function(lobbyId) {
			this.removeLobby(lobbyId);
		}, this));

		// not actually going to return a different value here since 
		if(_.isUndefined(lobby)) {
			winston.warn("Did not found any lobby matching " + JSON.stringify(teams) + " in league " + leagueId);
		}

		return lobby;
	},

	removeLobby: function(lobbyId) {
		delete this.lobbies[lobbyId];
		this.redis.del("lobby:" + lobbyId);
	}
};

GameStateTracker.prototype = _.extend(GameStateTracker.prototype, EventEmitter.prototype);

// export the primary object
module.exports = GameStateTracker;