var Canvas = require('canvas'),
	_ = require('underscore')._,
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

var heroSpriteSheetFile = fs.readFileSync("assets/heroes/minimap_hero_sheet.png");
var heroSpriteSheet = new Image; heroSpriteSheet.src = heroSpriteSheetFile;

var heroes = JSON.parse(fs.readFileSync("lib/heroes.json"));


function saveCanvas(canvas, filename, cb) {
	winston.info("Writing out completed canvas to " + filename);

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

function saveCanvasToBase64String(canvas, cb) {
	canvas.toBuffer(function(err, buff) {
		if(err) {
			winston.error("error converting canvas to buffer: "+ err);
			cb && cb(null);
			return;
		}

		winston.info("canvas to buffer complete: " + buff.length);

		b64buff = buff.toString('base64');

		winston.info("encoded as b64, len: " + b64buff.length);

		cb && cb(b64buff);
	});
}

function drawImageForHeroId(heroId, dx, dy, ctx, scale) {
	// the 'heroes' object contains all we need for this. It's a list of hero
	// objects with their heroIds and their x/y positions within the minimap 
	// sheet. 

	if(_.isUndefined(scale)) {
		scale = 24;
	}

	var hero = _.find(heroes, function(hero) {
		return hero.id == heroId;
	});

	if(_.isUndefined(hero)) {
		return;
	}

	ctx.drawImage(heroSpriteSheet, hero.x, hero.y, 32, 32, dx, dy, scale, scale);
}

module.exports.drawImageForHeroId = drawImageForHeroId;
module.exports.saveCanvas = saveCanvas;
module.exports.saveCanvasToBase64String = saveCanvasToBase64String;