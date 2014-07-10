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
var BACKGROUND_COLOR_RADIANT = "#91a43a";
var BACKGROUND_COLOR_DIRE = "#c23c29";
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
	ctx.fillStyle = BACKGROUND_COLOR_DIRE;
	ctx.fillRect(0, 0, 400, 100);

	ctx.fillStyle = BACKGROUND_COLOR_RADIANT;
	ctx.fillRect(0, 100, 400, 100);

	ctx.save();

	// okay, first step:
	// 1. Do the two team names.
	ctx.font = "bold 18px Helvetica";
	ctx.fillStyle = "#fff";

	_.each(["radiant", "dire"], function(team) {
		// the game.teams listing is unreliable,
		// check te last snapshot instead.
		var name = game.lastSnapshot[team + "_team"].team_name;
		var team_id = game.lastSnapshot[team + "_team"].team_id;

		var coords = {};
	
		// team logos are 250x150
		// we'll shrink them down to 40 high, so 67 wide
		// try to read the file for the team_id.
		var teamLogo = false;
		var logoImage = null;
		var offset = 5;

		try {
			teamLogo = fs.readFileSync("assets/teams/" + team_id + ".png");
			logoImage = new Image;
			logoImage.src = teamLogo;
			offset = 40;
		} catch (e) {
			winston.warn("Issue loading team logo: " + e);
		}

		var textOffset = 0;
		if(team=="radiant") {
			coords = {x:offset, y:23, heroY: 40};
		} else {
			coords = {x:offset, y:190, heroY: 200-90};
		}


		ctx.font = "bold 20px Helvetica";

		var teamWidth = ctx.measureText(name).width;

		if(teamLogo) {
			ctx.drawImage(logoImage, (400-teamWidth-35)/2, coords.y-20, 30, (logoImage.width/logoImage.height)*30);
			ctx.fillText(name, (400-teamWidth-35)/2 + 35, coords.y-6);
		} else {
			ctx.fillText(name, (400-teamWidth)/2, coords.y-6);
		}




		// we want to spread out evenly here.
		// assume a 10 pixel margin on each side
		// divide the rest evenly by 5, that's 76 pixel wide columns
		// center everything within those
		ctx.font = "10px Helvetica";
		var xPos = 10;
		_.each(_.filter(game.picks, function(pick) { return pick.team==team; }),
			function(player, index) {
				ctx.save();

				ctx.translate(xPos, coords.heroY);
				util.drawImageForHeroId(player.hero, 21, 0, ctx, 36);
				var textWidth = ctx.measureText(player.name).width;
				winston.info(textWidth);
				ctx.fillText(player.name, (76-textWidth)/2, 48);

				ctx.restore();
				xPos += 78;
		});		
	});

	// ctx.strokeStyle = "#cccccc";
	// ctx.moveTo(0, 100);
	// ctx.lineTo(400, 100);
	// ctx.stroke();

	ctx.font = "italic 16px sans-serif";
	var versusWidth = ctx.measureText("versus").width;
	ctx.fillText("versus", (400-versusWidth)/2, 105);

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