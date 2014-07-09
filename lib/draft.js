var Canvas = require('canvas'),
	_ = require('underscore')._,
	util = require('./canvas-util.js'),
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

var heroSpriteSheetFile = fs.readFileSync("assets/heroes/minimap_hero_sheet.png");
var heroSpriteSheet = new Image; heroSpriteSheet.src = heroSpriteSheetFile;

var heroes = JSON.parse(fs.readFileSync("lib/heroes.json"));

var BACKGROUND_COLOR = "#535656";
var GOLD_COLOR = "#ffd705";

// this viz depends only on the draft information. It includes the team names,
// the heroes picked for each team, and the players who are playing each hero.
// the notion is this tweet will go out when the game starts. we'll probably put
// this on a THIRD twitter account and I'll RT by hand for major matches. 
function generate(game, cb) {
	// start caching both of these in one file so we can
	// test generation that includes matchMetadata
	winston.info("generating draft image for lobby: " + game.lobby_id);
	if(_.isUndefined(game.lobby_id)) {
		winston.error("lobby id undefined, snapshotID: " + game.lastSnapshot.lobby_id);
	}

	// stop caching game info entirely on production	
	var exists = fs.existsSync("/tmp/draft_" + game.lastSnapshot.lobby_id + ".json");
	if(!exists) {
		fs.writeFileSync("/tmp/draft_" + game.lastSnapshot.lobby_id + ".json", JSON.stringify(game));
	}

	canvas = new Canvas(400,200)
	ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;

	// ACTUAL RENDER LOGIC STARTS HERE
	ctx.fillStyle = BACKGROUND_COLOR;
	ctx.fillRect(0, 0, 400, 200);

	ctx.save();



	ctx.restore();
	// RENDER ENDS

	try {
		util.saveCanvas(canvas, "draft_" + game.lastSnapshot.lobby_id, cb);		
	} catch (e) {
		winston.error("Issue saving canvas: " + e);
	}

	return game.lastSnapshot.lobby_id;
}


module.exports.generate = generate;