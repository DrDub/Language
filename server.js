#!/bin/env node
var express = require('express');
var fs      = require('fs');
var _ = require('underscore')._;
var assert = require('assert');

var Handlebars = require('handlebars');
Handlebars.registerHelper('stringify', function(object) {
    return JSON.stringify(object);
});
//Database:
var mongo = require('mongoskin');
var db;
//For connecting to github api:
var https = require('https');
var pipette = require('pipette');

var config = require('./config');


var langNodes = require('./langNodes');

//  Local cache for static content [fixed and loaded at startup]
var zcache = {};
zcache.indexTemplate = Handlebars.compile(fs.readFileSync('index.html', encoding='utf8'));
zcache.resultsTemplate = Handlebars.compile(fs.readFileSync('results.html', encoding='utf8'));

// Create "express" server.
var app  = express.createServer();

app.configure(function(){
	//app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
	app.use(express.bodyParser());//This must come before router
	app.use(app.router);
	//app.use(express.static('./ace-builds'));
    app.use(express.static('./static'));
});

/*  =====================================================================  */
/*  Setup route handlers.  */
/*  =====================================================================  */

// Handler for GET /health
app.get('/health', function(req, res){
    res.send('1');
});
app.get('/category/:category', function(req, res){
    //TODO: Check that the category exists.
    var renderedTemplate;
    var category = req.params.category;
    if('q' in req.query){
        db.collection('langNodes').find().toArray(function(err, items){
            if(err) throw err;
            renderedTemplate = zcache.resultsTemplate({interpretations: items, parseId:123, query: req.query.q});
            res.send(renderedTemplate);
        });
    } else {
        renderedTemplate = zcache.indexTemplate({'category' : category});
        res.send(renderedTemplate);
    }
});
// Handler for GET /
app.get('/', function(req, res){
    //res.writeHead(200, {'Content-Type': 'text/plain'});
    var renderedTemplate;
    if('q' in req.query){
        res.send(req.query);
        return;
    } else {
        var category = 'main';
        renderedTemplate = zcache.indexTemplate({'category' : category});
        res.send(renderedTemplate);
        return;
    }
    /*
    //TODO: Cache the templates
    var template = Handlebars.compile("{{stringify jsonObject}} says hi.");
	res.send(template({jsonObject : {title: "nathan"}}));
	return;

    db.collection('langNodes').find().toArray(function(err, items){
        if(err) throw err;
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(JSON.stringify(items));
    });
    */

	/*
	I would like to be able to do a recursive map reduce call where my map function
	does another map reduce, and the nested reduce
	Furthermore I would like to do this in responce to a node.js request.
	Is this possible?

	Complicated recursive map reduce query

	I'm trying to write a handler in node.js that does the following:
	Performs a root MapReduce job
	In the root map function creates child map reduce jobs.
	And passes its emit function into the child job's scope to be called from its finalize function
	https://groups.google.com/forum/?fromgroups#!forum/mongodb-user

	Think about:
	Instead of NTs having arrays, they could just be a bunch of nodes with the same name.
	Might make them easier to rank bc order wouldn't be inherent

	var result = db.collection("langNodes").mapReduce(
		String(function(){
			emit( 'x' , this );
		}),
		String(function(key, values){
			return values[0];
		}),
		{out: { inline : 1},
			finalize : String(function(){
				res.send('hi');
			})
		}
	);

	//Thanks to
	//http://benl.com/post/19927781665/mapreduce-with-mongodb-node-js
	//for documenting MR syntax
	var closure = function(){
		return 12;
	};
	var result = db.executeDbCommand(
		{
			mapreduce : "langNodes",
			map : String(function(){
				emit( 'x' , this );
			}),
			reduce : String(function(key, values){
				return values[0];
			}),
			out : {inline : 1}
		},
		function(err, dbres) {
			if(err) {
				res.send("ERR");
				//throw err;
			} else {
				var results = dbres.documents[0].results;
				res.send(JSON.stringify(results));
			}
		}
	);
    */
});
/**
 * Return info on a language node and sync it with its repo
 **/
app.get('/langNode/:id', function (req, res) {
    var id = req.params.id;
    db.collection('langNodes').findById(id, function (err, langNode) {
        if (err || langNode === null) {
            res.send('Error: ' + err);
            return;
        }
        var repo = langNode.repository;
        if (repo.type === 'gist') {
            https.request({
                host: 'api.github.com',
                port: 443,
                path: '/gists/' + repo.gistId,
                method: 'GET'
            }, function (gitres) {
                var gitdata = new pipette.Sink(gitres);
                gitdata.on('data', function (data) {
                    var gistJson = JSON.parse(data.toString());
                    var langNodeFile = gistJson.files['languageNode.json'];
                    var lastGistCommitDate = new Date(gistJson.history[0].committed_at);
                    var lastSyncDate = langNode.lastSync ? new Date(langNode.lastSync) : new Date(0);
                    if (lastGistCommitDate > lastSyncDate) {
                        var newLangNode = _.extend({
                                repository: langNode.repository,
                                files: gistJson.files,
                                lastSync: new Date()
                            },
                            JSON.parse(langNodeFile.content));
                        db.collection('langNodes').update({
                                'id': langNode.id
                            },
                            newLangNode,
                            {
                                upsert: true,
                                safe: true
                            },
                            function (err, result) {
                                assert.equal(null, err);
                                assert.equal(1, result);
                                res.send('SYNCED:' + JSON.stringify(newLangNode));
                            });
                    } else {
                        res.send('Already synced: ' + data.toString());
                    }
                });
            }).on('error', function (e) {
                res.send(e);
            }).end();
        }
        else if (repo.type === 'github') {
            //see:
            //http://developer.github.com/v3/repos/contents/
        }
        else {
            res.send(JSON.stringify(langNode));
        }
    });
});

//TODO: This has security issues I believe.
//TODO: Turn this into a way to submit LangNodes
app.post('/', function(req, res){
	db.collection('test').update({'name':'main'},
		{ $set : req.body });
	res.send(req.body, {'Content-Type': 'text/html'});
});

//  Get the environment variables we need.
var ipaddr, port;
if(config.openshift){
    ipaddr = process.env.OPENSHIFT_INTERNAL_IP;
    port = process.env.OPENSHIFT_INTERNAL_PORT || 8080;
} else {
    ipaddr = process.env.IP;
    port = process.env.PORT;
}

if (typeof ipaddr === "undefined") {
   console.warn('No OPENSHIFT_INTERNAL_IP environment variable');
}

//  terminator === the termination handler.
function terminator(sig) {
   if (typeof sig === "string") {
      console.log('%s: Received %s - terminating Node server ...',
                  Date(Date.now()), sig);
      process.exit(1);
   }
   console.log('%s: Node server stopped.', Date(Date.now()) );
}

//  Process on exit and signals.
process.on('exit', function() { terminator(); });

['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGTERM'
].forEach(function(element, index, array) {
    process.on(element, function() { terminator(element); });
});


//Question: What is the ideal place to connect to the db
app.listen(port, ipaddr, function() {
    db = mongo.db(config.databaseUrl);
	//init LangNodes
    var testNodes = [
        _.extend(Object.create(langNodes.baseNode), {hi:'hi'})
        //Object.create(langNodes.baseNode)
	];
    testNodes.forEach(function(element, index, array) {
		db.collection('langNodes').update({'id':element.id},
			element,
			{upsert:true, safe:true},
			function(err, result) {
				assert.equal(null, err);
				assert.equal(1, result);
			});
	});
    console.log('%s: Node server started on %s:%d ...', Date(Date.now() ), ipaddr, port);
});