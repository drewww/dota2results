var winston = require('winston'),
	_ = require('underscore')._;

function GameStateTracker(redis) {
	this.lobbies = {};
	this.redis = redis;
	this.lobbiesThisTick = [];

	winston.info("Constructed game state tracker.");
}

// the primary internal data structure here is the lobbies object
// it maps lobbyId keys to an object that contains a few pieces
// of info:
//	- lastTimestamp
//	- lastSnapshot
//	- goldHistory: list of {timestamp, radiantGold, direGold, diff} objects
//	- events: list of {event_type, timestamp, team, ...} (include other random metadata)
//	- allSnapshots: []

GameStateTracker.prototype = {
	lobbies: null,

	lobbiesThisTick: null,

	processSnapshot: function(snapshot) {

		var lobby;
		var lobbyId = snapshot.lobby_id;

		winston.info("Pocessing snapshot for " + lobbyId);
		// winston.info(JSON.stringify(snapshot));

		this.lobbiesThisTick.push(lobbyId);

		if(lobbyId in this.lobbies) {
			lobby = this.lobbies[lobbyId];
			winston.debug("Found existing lobby for " + lobbyId);

			// check about the time gap between snapshots
			// there's potentially an issue when there's a big gap
			if((snapshot.scoreboard.duration - lobby.lastTimestamp) > 60) {
				winston.warn("More than 60 seconds gap in snapshots for " + lobbyId);				
			}

			if(snapshot.scoreboard.duration==lobby.lastTimestamp) {
				winston.warn("Duplicate snapshot detected in lobby " + lobbyId + " for time " + lobby.lastTimestamp);

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

			lobby.goldHistory.push(this.handleGold(lobby, snapshot));

			winston.info("gold: " + JSON.stringify(lobby.goldHistory));

			_.each(this.handleEvents(lobby, snapshot), _.bind(function(event) {
				lobby.events.push(event);
			}, this));

			lobby.lastSnapshot = snapshot;
			lobby.lastTimestamp = snapshot.scoreboard.duration;

			lobby.allSnapshots.push(snapshot);
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
				allSnapshots: []
			};

			winston.info("Creating a new lobby entry for an unseen lobby.");
		}

		this.lobbies[lobbyId] = lobby;
	},

	finish: function() {
		// look for lobbyIds that we didn't see updates for in this last cycle.
		// those are probably games that have ended.

		var lobbiesTracked = Object.keys(this.lobbies);
		winston.info("tracked: " + JSON.stringify(lobbiesTracked));

		var lobbiesMissed = _.reject(lobbiesTracked, _.bind(function(lobbyId) {
			return ! (parseInt(lobbyId) in this.lobbiesThisTick);
		}, this));

		winston.info("MISSED LOBBY IDS: " + JSON.stringify(lobbiesMissed));
		_.each(lobbiesMissed, _.bind(function(lobbyId) {
			// Eventually we will do something dramatic here. This is when we'll
			// kick off processing for the image.

			winston.info("Deleting: " + lobbyId);
			delete this.lobbies[lobbyId];
		}, this));
	},

	// returns a list of new events.
	handleEvents: function(lobby, snapshot) {
		// we're looking for changes in:
		//	tower state
		//	kills (eh, skip this for now)
		//	roshan (eventually; might be challenging to detect in 60s increments)
		//  ?? items?

		if(lobby.lastSnapshot.tower_state != snapshot.tower_state) {
			winston.info("Detected a tower state change: " + lobby.lastSnapshot.tower_state + " -> " + 
				snapshot.tower_state);

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
		    	{team:"radiant", tier: 1, lane: "top", mask: Math.pow(2, 0)},
		    	{team:"radiant", tier: 2, lane: "top", mask: Math.pow(2, 1)},
		    	{team:"radiant", tier: 3, lane: "top", mask: Math.pow(2, 2)},
		    	{team:"radiant", tier: 1, lane: "mid", mask: Math.pow(2, 3)},
		    	{team:"radiant", tier: 2, lane: "mid", mask: Math.pow(2, 4)},
		    	{team:"radiant", tier: 3, lane: "mid", mask: Math.pow(2, 5)},
		    	{team:"radiant", tier: 1, lane: "bot", mask: Math.pow(2, 6)},
		    	{team:"radiant", tier: 2, lane: "bot", mask: Math.pow(2, 7)},
		    	{team:"radiant", tier: 3, lane: "bot", mask: Math.pow(2, 8)},
		    	{team:"radiant", tier: 4, lane: "bot", mask: Math.pow(2, 9)},
		    	{team:"radiant", tier: 4, lane: "top", mask: Math.pow(2, 10)},
		    	{team:"dire", tier: 1, lane: "top", mask: Math.pow(2, 11)},
		    	{team:"dire", tier: 2, lane: "top", mask: Math.pow(2, 12)},
		    	{team:"dire", tier: 3, lane: "top", mask: Math.pow(2, 13)},
		    	{team:"dire", tier: 1, lane: "mid", mask: Math.pow(2, 14)},
		    	{team:"dire", tier: 2, lane: "mid", mask: Math.pow(2, 15)},
		    	{team:"dire", tier: 3, lane: "mid", mask: Math.pow(2, 16)},
		    	{team:"dire", tier: 1, lane: "bot", mask: Math.pow(2, 17)},
		    	{team:"dire", tier: 2, lane: "bot", mask: Math.pow(2, 18)},
		    	{team:"dire", tier: 3, lane: "bot", mask: Math.pow(2, 19)},
		    	{team:"dire", tier: 4, lane: "bot", mask: Math.pow(2, 20)},
		    	{team:"dire", tier: 4, lane: "top", mask: Math.pow(2, 21)}
		    ];

		    // first, get just the bits that have changed, eg
		    //	0011010	- previous
		    //	0010010	- now
		    //		XOR
		    //	0001000 - only bits that are either in one or the other.
		    //			  technically this would turn up towers that went
		    //			  from 0 to 1, but that can't happen game-wise.

		    var towersChanged = lobby.lastSnapshot.tower_state ^ snapshot.tower_state;

		    // loop through all potential towers.
		    // try masking each one.
		    var events = [];
		    _.each(towerTypes, function(tower) {
		    	if(towersChanged & tower.mask) {
		    		var e = _.clone(tower);
		    		e.time = snapshot.scoreboard.duration;
		    		events.push(e);

		    		winston.info("TOWER FELL: " + JSON.stringify(e));
		    	}
		    });

		    return events;
		} else {
			// no tower change events detected.
			return [];
		}
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
				sumGold+= Math.floor(player.gold_per_min * (snapshot.scoreboard.duration/60.0));
			});

			gold[team] = sumGold;
		});

		return {time: snapshot.scoreboard.duration,
				radiantGold: gold.radiant,
				direGold: gold.dire,
				diff: (gold.radiant - gold.dire)};
	},
};

// export the primary object
module.exports = GameStateTracker;