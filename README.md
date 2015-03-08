dota2results
============

A twitter bot that posts Dota 2 tournament results. Live at https://twitter.com/dota2results and https://twitter.com/dota2resultsall. 

Architecture
------------

This bot runs on Heroku, and is essentially just a bridge between the Dota2 Web API (http://wiki.teamfortress.com/wiki/WebAPI) and Twitter.

This turns out to be a somewhat more complicated process than you might expect, becaues the Dota2 API is not necessarily the friendliest design for this use case. As a result, the basic flow of the bot is somewhat complicated. Minus some initialization, the core loop looks like this:

 1. Get a list of leagues that currently have live games.
 2. Get a list of matches for each league that has an active game (or recently had an active game).
 3. Compare the most recent game in each league with the last known game on record for that league.
 4. If it's different, load the match details for that specific match.
 5. Process the match details and generate a relevant tweet.

There is a bunch of added complexity around delaying the tweets so they align with stream delays, keeping track of the series status (the API only notes that a game is part of a series, but doesn't give you the current state of the series, eg 1-1 in a bo5, and other details. There are also some tricky bits around restarting the bot (which happens whenever I deploy a new version) without losing games that were in-the-pipeline for being tweeted. In-line comments are pretty decent at providing context.

Boxscores
---------

The boxscore image generating system is a whole other situation. As of June 2014, Valve added real-time updates to GetLiveLeagueGames method. For each game, up-to-the-minute (sort of) scoreboard information is available, including per-player item loadouts, GPM/XMP, kill score, tower information, etc. There are two caveats:

 * The data is not available historically. The request gives you the latest data available, but older snapshots are not available anywhere as far as I can see.
 * The API servers seem to only get updates from the game servers every 60-120 seconds. So the data we're getting is "real time" in a certain sense, but pretty low temporal resolution.

To deal with these issues, there is a major new module, `lib/gamestate.js`, which manages the details of tracking status-over-time of all open league games. The main `dota2results.js` script calls GetLiveLeagueGames every 20 or so seconds and sends the resulting snapshots of each game over to a GameStateTracker object for processing. The GameStateTracker has three major functions:

 1. Ignore duplicate snapshots (we generally see the same snapshot 4-6 times before we get a genuinely new one)
 2. Generate total gold differential data. Historically this was very painful, but net work is now reported in the API, which is great.
 3. Detect towers falling. Each snapshot includes a bit mask that encodes tower states. Extract diffs in these masks to determine which towers fell and who to attribute them to, isolating these events into a single list of towers-that-fell. 
 4. Detect barracks falling. Same method as above, although it seems to work a lot less well for reasons I have not yet figured out.

GetLiveLeagueGames has improved dramatically in the last year, but there are some big gaps in what is available:

 * The game winner is not available in a formal way. We can detect lobbies closing because they stop getting returned by GetLiveLeagueGames and we could maybe infer the winner most of the time, but it's not reported directly.
 * Kill data as reported by the final scoreboard doesn't seem to match kill data reported by GetMatchDetails.
 * The time of the final snapshot is usually substantially lower than the time reported in GetMatchDetails.
 * Games are organized by lobby_id, which is a transient id that is separate from the more enduring match_id, which makes matching lobby data back to match data a little squishy.

This data is accumulated over time. When the normal game-end detection system from the primary `dota2results.js` logic identifies that a game has finished, it looks up GameStates that seem to match the GetMatchDetails information, relying on league_id and team_id. Merging the MatchDetails object with the accumulated GameState object gives us enough data to make a good visualization.

The visualization process is handled by `boxscores.js`. Most of the work here is in the design, the actual code is a pretty straightforward translation of the target design into node-canvas style code that can generate an image. The `generate()` function takes a MatchDetails object and a GameState object and combines them to create an appropriage image. This function draws on cached images of heroes. It doesn't have any major unusual dependencies, it's just a lot of detailed image work.


Setup
-----

To run this locally, you'll need a valid Steam API key. If you want to post to Twitter, you'll need the relevant Twitter credentials (consumer key, consumer secret, access key, and access secret). In production mode, I strongly recommend providing a redis instance for caching across bot restarts, but the bot should run fine without one, especially in development mode. All configuration is found in `conf.sh.example`, which you should use to configure your environment appropriately using `source conf.sh`. 

Contribution
------------

If you're interested in contributing, I can always use help keeping track of Twitter handles for teams. You can find the instructions for doing that in `lib/twitter_handles.js`. 

Recent Improvements
-------------------
  * Auto-generate images to include in the tweets that provide a visual summary of the match, ala the end-game scoreboard.
  * Now reads premier/professional/amateur status so long term whitelisting is less burdensom.

Future Directions
-----------------

  * Live-tweet significant moments in matches (ie big team fights, towers going down, etc); requires access to the real time DotaTV stream or other real-time data. 
