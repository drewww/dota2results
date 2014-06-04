var Canvas = require('canvas'),
	_ = require('underscore')._,
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

var heroSpriteSheetFile = fs.readFileSync("assets/heroes/minimap_hero_sheet.png");
var heroSpriteSheet = new Image; heroSpriteSheet.src = heroSpriteSheetFile;

var heroes = JSON.parse(fs.readFileSync("lib/heroes.json"));

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
function generate(game) {
	canvas = new Canvas(400,200)
	ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;


	winston.info("generating image for lobby: " + game.lobby_id);
	// for now, just cache the games locally.
	// fs.writeFile("games/" + game.lobby_id + ".json", JSON.stringify(game));

	// ACTUAL RENDER LOGIC STARTS HERE
	ctx.fillStyle = "#132427";
	ctx.fillRect(0, 0, 400, 200);


	// render the header and footer team names
	ctx.font = "bold 20px Helvetica";
	ctx.fillStyle = "#fff";

	_.each(["radiant", "dire"], function(team) {
		var name = game.teams[team].team_name;
		var coords = {};
	
		if(team=="radiant") {
			coords = {x:10, y:25};
		} else {
			coords = {x:10, y:200-10};
		}

		ctx.fillText(name, coords.x, coords.y);

		_.each(game.lastSnapshot.scoreboard[team].players, function(player, index) {
			drawImageForHeroId(player.hero_id, coords.x + 250 + (index*28), coords.y-20, ctx);
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
	// that right edge is 5 pixe margin - 50 pixels for kill info
	// so, pixels per second
	var timeScaling = 345.0/3600.0;

	// eventually this will be a log scale, but for now we'll do linear.
	// we want the graph to be about 100 pixels high and support a domain
	// of -20k -> +20k. so, pixels per gold diff. +/-, so do half.
	var goldScaling = 50.0/20000.0;
	// ctx.moveTo(0, 0);
	
	var curX = 0;

	_.each(game.goldHistory, function(snapshot, index) {
		winston.info(index + "; " + game.goldHistory.length);
		// if((index+20)>=game.goldHistory.length) {
		// 	winston.info("STOP");
		// 	return;
		// }
		if(snapshot.diff > 0) {
			ctx.fillStyle = "#f00";
			ctx.strokeStyle = "#f00";
			ctx.fillRect(curX, 0, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling);
			ctx.strokeRect(curX, 0, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling);
		} else {
			ctx.fillStyle = "#0f0";
			ctx.strokeStyle = "#0f0";
			ctx.fillRect(curX, snapshot.diff*goldScaling, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling*-1);
			ctx.strokeRect(curX, snapshot.diff*goldScaling, snapshot.time*timeScaling-curX, snapshot.diff*goldScaling*-1);
		}

		curX = snapshot.time*timeScaling;
		winston.info(curX);
	});

	// ctx.stroke();

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
    _.each(game.events, function(towerEvent) {
    	var towerOffset = 25;
    	if(towerEvent.team=="radiant") {
    		towerOffset = towerOffset*-1;
    	}

    	var x = towerEvent.time * timeScaling;
    	var TOWER_BOX_SIZE = 6;
    	ctx.fillStyle = "#fff";
    	ctx.fillRect(x-TOWER_BOX_SIZE/2, towerOffset, TOWER_BOX_SIZE, TOWER_BOX_SIZE);
    });

	ctx.restore();
	
	// render the end game kill information on the right side.
	ctx.translate(355, 50);

	// first, the k.
	ctx.font = "bold 14px Helvetica";
	ctx.fillText("K", 12, 5);

	// now do radiant then dire
	var y = 40;
	ctx.font = "bold 32px Helvetica";

	// I'm not totally sure why I need to flip this, but it seems like every game
	// I test against where it's an obvious victor and the kill number should be
	// lopsided, it's reversed, so here I am. I'll double check this against
	// games once I can link them back to dotabuff info.
	_.each(["dire", "radiant"], function(team) {
		// decide if this team won or lost, and pick colors
		// appropriately.

		var kills = game.lastSnapshot.scoreboard[team].score;
		ctx.fillText(kills, 0, y);

		y += 40;
	});

	ctx.restore();
	// RENDER ENDS

	saveCanvas(canvas, game.lobby_id);
}

function saveCanvas(canvas, filename) {
	var out = fs.createWriteStream("images/" + filename + '.png');
	var stream = canvas.pngStream();

	stream.on('data', function(chunk){
	  out.write(chunk);
	});

	stream.on('end', function(){
	  winston.info('saved png: ' + filename + ".png");
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

	ctx.drawImage(heroSpriteSheet, hero.x, hero.y, 32, 32, dx, dy, 24, 24);
}


module.exports.generate = generate;