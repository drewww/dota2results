var Canvas = require('canvas'),
	_ = require('underscore')._,
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

var heroSpriteSheetFile = fs.readFileSync("assets/heroes/minimap_hero_sheet.png");
var heroSpriteSheet = new Image; heroSpriteSheet.src = heroSpriteSheetFile;

var heroes = JSON.parse(fs.readFileSync("lib/heroes.json"));

var BACKGROUND_COLOR = "#3d4141";
var GOLD_COLOR = "#ffd705";

// this library is stateless. Given a final game snapshot,
// generates an image that represents that information
// concisely.

// NOTE: we're going to need to delay this call until later in the
// process when we have the matchDetails information to join
// with the game history information. Otherwise, we don't have
// a way to get at series status info or ultimate winner.
//
// I'll come back to this issue later, though; we can get most
// of the viz built without that info and will work out the two
// tiered problem that is matching mainline scraper results
// with the accumulated game state results. I don't expect that
// to be THAT hard, but it is going to involve searching through
// recently recorded game results and look for the same two teams
// playing in the same tournament. 
function generate(game, matchMetadata, cb) {
	// start caching both of these in one file so we can
	// test generation that includes matchMetadata
	winston.info("generating image for lobby: " + game.lobby_id);

	var out = {game:game, metadata:matchMetadata};

	// stop caching game info entirely on production	
	// var exists = fs.existsSync("/tmp/joint_" + game.lobby_id + ".json");
	// if(!exists) {
	// 	fs.writeFileSync("/tmp/joint_" + game.lobby_id + ".json", JSON.stringify(out));
	// }

	canvas = new Canvas(400,200)
	ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;

	if(matchMetadata) {
		winston.info("...has match metadata: " + JSON.stringify(matchMetadata));
	}

	winston.info("generating image for lobby: " + game.lobby_id);

	// for now, just cache the games locally.
	// fs.writeFile("games/" + game.lobby_id + ".json", JSON.stringify(game));

	// ACTUAL RENDER LOGIC STARTS HERE
	ctx.fillStyle = BACKGROUND_COLOR;
	ctx.fillRect(0, 0, 400, 200);


	// render the header and footer team names
	ctx.font = "bold 12px Helvetica";
	ctx.fillStyle = "#fff";

	_.each(["radiant", "dire"], function(team) {
		// the game.teams listing is unreliable,
		// check te last snapshot instead.
		var name = game.lastSnapshot[team + "_team"].team_name;
		var team_id = game.lastSnapshot[team + "_team"].team_id;

		var winner = _.find(matchMetadata.teams, function(team) {
			return team.team_id==team_id;
		}).winner;

		var coords = {};
	
		// team logos are 250x150
		// we'll shrink them down to 40 high, so 67 wide
		// try to read the file for the team_id.
		var teamLogo = false;
		var logoImage = null;
		var offset = 5;

		// for now disable team image loading since the images are bad.
		// turn this back on later once I've isolated the pennant graphics
		// by hand.
		// try {
		// 	teamLogo = fs.readFileSync("assets/teams/" + team_id + ".png");
		// 	logoImage = new Image;
		// 	logoImage.src = teamLogo;
		// 	offset = 64;
		// } catch (e) {
		// 	winston.warn("Issue loading team logo: " + e);
		// }

		var textOffset = 0;
		if(team=="radiant") {
			coords = {x:offset, y:23};
		} else {
			coords = {x:offset, y:200-7};
		}

		if(teamLogo) {
			ctx.drawImage(logoImage, 5, coords.y-18, 40, 24);
		}


		if(winner) {
			ctx.fillStyle = GOLD_COLOR;
		} else {
			ctx.fillStyle = "#fff";
		}

		ctx.fillText(name, coords.x, coords.y-10);

		// Series data goes here
		var seriesStatus = matchMetadata.seriesStatus;

		if(seriesStatus && ("series_type" in seriesStatus)) {
			var gamesToWin = seriesStatus.series_type+1;
			var wins = seriesStatus.teams[game.lastSnapshot[team + "_team"].team_id];			

			// now we're gong to make as many empty blocks as there are games to win
			// and set the backgrounds gold for the ones that are < wins.
			var seriesCoords = {x:coords.x, y:coords.y+4};
			ctx.strokeStyle = "#ccc";
			ctx.lineWidth = 1;
			for(var i=0; i<gamesToWin; i++) {

				if(i<wins) {
					ctx.fillStyle = GOLD_COLOR;
				} else {
					// paint it gold!
					ctx.fillStyle = "rgba(0,0,0,0.7)";
				}

				ctx.strokeRect(seriesCoords.x+2, seriesCoords.y-10, 15, 8);
				ctx.fillRect(seriesCoords.x+2, seriesCoords.y-10, 15, 8);

				seriesCoords.x += 20;
			}
		}


		_.each(game.lastSnapshot.scoreboard[team].players, function(player, index) {
			drawImageForHeroId(player.hero_id, coords.x + 260 - offset + (index*28), coords.y-20, ctx);
		});		
	});

	// render the gold graph
	ctx.save();

	// translate into a coordinate system where 0 is 0, and halfway down the chart.
	ctx.translate(5, 100);

	// draw a center line
	ctx.strokeStyle = "#707070";
	ctx.moveTo(0, 0);
	ctx.lineTo(345, 0);
	ctx.stroke();

	// relevant scaling info
	// we're scaling our x axis to be 0->60 minutes
	// eventually we'll be flexible above 60, but for now just do a fixed
	// scaling. This means 0 time to 3600 seconds, over 340 pixels.
	// that right edge is 5 pixel margin - 50 pixels for kill info
	// so, pixels per second

	// okay, here's where the x axis flexiblity comes in. if the game
	// duration is > 3600, then we'll scale down to meet it.
	// otherwise, we fix the right edge of the axis at exactly 60mins.

	var timeScaling;
	var endTime;
	var overtime = false;
	if(game.lastSnapshot.scoreboard.duration > 3600) {
		timeScaling = 345.0/game.lastSnapshot.scoreboard.duration;
		overtime = true;
		endTime = game.lastSnapshot.scoreboard.duration;
	} else {
		timeScaling = 345.0/3600.0;
		endTime = 3600.0;
	}

	// eventually this will be a log scale, but for now we'll do linear.
	// we want the graph to be about 100 pixels high and support a domain
	// of -20k -> +20k. so, pixels per gold diff. +/-, so do half.
	var goldScaling = 50.0/20000.0;
	// ctx.moveTo(0, 0);
	
	var curX = 0;

	if(game.goldHistory.length<10) {
    	winston.error("Decling to generate a boxscores image because this lobby has no gold events");
    	winston.error("for " + game.lastSnapshot.radiant_team.team_name + " and " + game.lastSnapshot.dire_team.team_name);
		return false;
	}

	_.each(game.goldHistory, function(snapshot, index) {
		winston.info(index + "; " + game.goldHistory.length);

		// flip this, since in this context
		// positive numbers go down because of the way the graphics
		// axes are setup.
		snapshot.diff = snapshot.diff*-1;

		if(snapshot.diff > 0) {
			ctx.fillStyle = "#d5342b";
			ctx.strokeStyle = "#d5342b";
			ctx.fillRect(curX, 0, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling);
			ctx.strokeRect(curX, 0, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling);
		} else {
			ctx.fillStyle = "#80b238";
			ctx.strokeStyle = "#80b238";
			ctx.fillRect(curX, snapshot.diff*goldScaling, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling*-1);
			ctx.strokeRect(curX, snapshot.diff*goldScaling, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling*-1);
		}

		// if this is the last one... do a special effect
		if(index == game.goldHistory.length-1) {
			ctx.beginPath();

			ctx.lineWidth = 2;
			ctx.strokeStyle = "#e2c61c";
			// ctx.strokeStyle = "#f00";
			ctx.fillStyle = ctx.strokeStyle;
			winston.info("STROKE STYLE: " + ctx.strokeStyle);

			ctx.moveTo(curX + (snapshot.time*timeScaling-curX), 15);
			ctx.lineTo(curX + (snapshot.time*timeScaling-curX), -15);
			ctx.stroke();
			ctx.closePath();

			var time = (snapshot.time / 60.0).toFixed(2);
			var mins = parseInt(time.split(".")[0]);
			var secs = Math.floor((parseInt(time.split(".")[1])/100)*60);

			if(secs < 10) {
				secs = "0" + secs;
			}
			ctx.fillStyle = "#fff";
			if(snapshot.time < 55*60) {
				// otherwise mark the time.	
				ctx.fillText(mins + ":" + secs, curX + (snapshot.time*timeScaling-curX) + 2, -5);
			} else {
				// flip it and show it on the left of the mark
				ctx.fillText(mins + ":" + secs, curX + (snapshot.time*timeScaling - curX) - 35, -5);
			}
		}

		curX = snapshot.time*timeScaling;
	});

	ctx.beginPath();
	ctx.strokeStyle = "#707070";
	ctx.moveTo(timeScaling*3600.00, -5);
	ctx.lineTo(timeScaling*3600.00, +5);
	ctx.stroke();
	ctx.closePath();

	ctx.beginPath();
	ctx.strokeStyle = "#707070";
	ctx.moveTo(0, -5);
	ctx.lineTo(0, +5);
	ctx.stroke();
	ctx.closePath();

	ctx.beginPath();
	ctx.moveTo(timeScaling*3600.00/2, -3);
	ctx.lineTo(timeScaling*3600.00/2, +3);
	ctx.stroke();
	ctx.closePath();

	for(var i=0; i<endTime; i+=(10*60)) {
		ctx.beginPath();
		ctx.moveTo(timeScaling*i, -2);
		ctx.lineTo(timeScaling*i, +2);
		ctx.stroke();
		ctx.closePath();
	}

	// okay now we're going to do towers
	// first pass, we're just doing white boxes spaced properly.
	// these are stored in events, like:
	// "events": [
    // {
    //   "team": "dire",
    //   "tier": 1,
    //   "lane": "bot",
    //   "mask": 131072,
    //   "time": 697.6629638671875
    // }, ... ]

    if(game.events.length == 0) {
    	winston.error("Decling to generate a boxscores image because this lobby has no game events");
    	return false;
    }
    _.each(game.events, function(towerEvent) {
    	var flip = 1;
    	var towerOffset = 25;
    	if(towerEvent.team=="dire") {
    		flip = -1;
    	}

    	var x = towerEvent.time * timeScaling;
    	var TOWER_BOX_SIZE = 6;
    	ctx.fillStyle = "#fff";
    	ctx.fillRect(x-TOWER_BOX_SIZE, flip*towerOffset + (8*(towerEvent.tier-1)*flip), TOWER_BOX_SIZE, TOWER_BOX_SIZE);
    });

    // TODO experiment with other representations of higher tier towers.
    // See the illustrator file for options for this. 

	ctx.restore();
	
	// render the end game kill information on the right side.
	ctx.translate(355, 50);

	// first, the k.
	ctx.fillStyle = "#fff";
	ctx.font = "bold 14px Helvetica";
	ctx.fillText("K", 12, 5);

	// now do radiant then dire
	var y = 40;
	ctx.font = "bold 32px Helvetica";

	_.each(["radiant", "dire"], function(team) {
		// decide if this team won or lost, and pick colors
		// appropriately.
		winston.info("team: " + JSON.stringify(game.lastSnapshot[team + "_team"]));
		var team_id = game.lastSnapshot[team + "_team"].team_id;
			var winner = _.find(matchMetadata.teams, function(team) {
				winston.info("checking " + JSON.stringify(team) + " for team id " + team_id);
				return team.team_id==team_id;
			}).winner;

		// this kill count is unreliable if we pull from snapshot, so 
		// we will aim for matchMetadata.teams. annoyingly, matchMetadata.teams
		// isn't organized by radiant/dire, it's a list of two. so we have to
		// to _.find to pull the right record.
		var team = _.find(matchMetadata.teams, function(team) {
			return team.team_id==team_id;
		});

		var kills = team.kills;

		if(winner) {
			ctx.fillStyle = GOLD_COLOR;
			ctx.fillRect(-2, y-30, 40, 40);

			ctx.fillStyle = BACKGROUND_COLOR;
			winston.info("winner! " + kills + " y " + y);
		} else {
			ctx.fillStyle = "#fff";
		}

		ctx.fillText(kills, 0, y);

		y += 40;
	});

	// now a little bit below the lowest one, do a small watermark.
	ctx.font = "10px Helvetica";
	ctx.fillStyle = "#666";
	ctx.fillText("@dota2results", -40, 120);

	ctx.restore();
	// RENDER ENDS

	saveCanvas(canvas, game.lastSnapshot.lobby_id, cb);

	return game.lobby_id;
}

function saveCanvas(canvas, filename, cb) {
	var out = fs.createWriteStream("/tmp/" + filename + '.png');
	var stream = canvas.pngStream();

	stream.on('data', function(chunk){
	  out.write(chunk);
	});

	stream.on('end', function(){
	  winston.info('saved png: ' + filename + ".png");

	  cb && cb(filename + ".png");
	});

	return;
}

function drawImageForHeroId(heroId, dx, dy, ctx) {
	// the 'heroes' object contains all we need for this. It's a list of hero
	// objects with their heroIds and their x/y positions within the minimap 
	// sheet. 

	var hero = _.find(heroes, function(hero) {
		return hero.id == heroId;
	});

	if(_.isUndefined(hero)) {
		return;
	}

	ctx.drawImage(heroSpriteSheet, hero.x, hero.y, 32, 32, dx, dy, 24, 24);
}


module.exports.generate = generate;