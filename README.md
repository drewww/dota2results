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


Setup
-----

To run this locally, you'll need a valid Steam API key. If you want to post to Twitter, you'll need the relevant Twitter credentials (consumer key, consumer secret, access key, and access secret). In production mode, I strongly recommend providing a redis instance for caching across bot restarts, but the bot should run fine without one, especially in development mode. All configuration is found in `conf.sh.example`, which you should use to configure your environment appropriately using `source conf.sh`. 

Contribution
------------

If you're interested in contributing, I can always use help keeping track of Twitter handles for teams. You can find the instructions for doing that in `lib/twitter_handles.js`. 

Future Directions
-----------------

  * Auto-generate images to include in the tweets that provide a visual summary of the match, ala the end-game scoreboard.
  * Live-tweet significant moments in matches (ie big team fights, towers going down, etc); requires access to the real time DotaTV stream or other real-time data.
  * Find a way to tap into the premier/professional/amateur categories to auto-group tournaments into different categories.
  * Provide an email list for people who want non-delayed results (this is primarily for people in esports production roles who need advance notice for production tasks)
