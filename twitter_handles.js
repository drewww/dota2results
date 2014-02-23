

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
// 1. Open the all_teams.txt file
// 2. Search for either the team name or team tag.
// 3. Look at the number on the left edge of that line, that's the team id.
// 4. Look up the twitter handle for that team.
// 5. Click 'edit' in the upper right hand corner.
// 6. Add a line in this file, following the format:
//		id, "twitter_handle",
// 7. Click 'Commit Changes'
//
// Then I'll review it and deploy it to the server
// and then the bot will know that team's twitter
// handle!


exports.teams = {
	36: "natusvincere",
	39: "EvilGenuises"
};