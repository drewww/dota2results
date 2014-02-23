var request = require('request'),
	winston = require('winston'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	fs = require('fs');

var api = new dazzle(process.env.STEAM_API_KEY);

var maxTeamId = 0;

var allTeams = [];

var stop = false;

var interval;


function getTeamsStartingAtId() {
	api.getTeamInfoByTeamID({start_at_team_id:maxTeamId}, function(err, res) {
		var teams = res.teams;

		if(err || teams.length==0) {
			winston.info("FINISHED: " + err + " teams.length=" + teams.length);

			fs.writeFile('all_teams.json', JSON.stringify(allTeams));

			var teamsText = "";
			_.each(allTeams, function(team) {
				teamsText = teamsText + team.team_id + "\t\t" + team.tag + "\t\t" + team.name + "\n";
			});

			fs.writeFile('all_teams.txt', teamsText);

			return;
		}

		winston.info(maxTeamId + "    found: " + teams.length);

		_.each(teams, function(team) {
			if(team.team_id > maxTeamId) {
				maxTeamId = team.team_id;
			}

			allTeams.push(team);
		});

		writeJSON();

		setTimeout(getTeamsStartingAtId, 1000);
	});	
}

function writeJSON() {
	fs.writeFile('all_teams.json', JSON.stringify(allTeams));
}

function loadJSON() {
	json = fs.readFileSync('all_teams.json', {encoding:"utf-8"});
	allTeams = JSON.parse(json);
	winston.info("team count: " + allTeams.length);

	_.each(allTeams, function(team) {
		if(team.team_id > maxTeamId) {
			maxTeamId = team.team_id;
		}
	});
	winston.info("max team id: " + maxTeamId);
}

try {
	loadJSON();
} catch (e){
	winston.info("err loading: " + e);
}

getTeamsStartingAtId();