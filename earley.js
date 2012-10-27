//TODO: Create StreamList w/ forEachThen, append, and finish methods
var assert = require('assert');
var _ = require('underscore')._;
var EventEmitter = require( "events" ).EventEmitter;
function isIncomplete(langNode) {
    console.log('isIncomplete');
    return (langNode.parseData.atComponent < langNode.components.length);
}
function replaceStringsWithTerminalObjects(langNode) {
    //Strings syntactic sugar to make it easier to langNode creators to define terminals.
    //Object terminals are needed so meta data can be attached to them.
    if (langNode.components) {
        langNode.components = _.map(langNode.components, function(component) {
            if (_.isString(component)) {
                return {
                    terminal: component
                };
            }
            else if (_.isObject(component)) {
                replaceStringsWithTerminalObjects(component);
                return component;
            }
        });
    }
}
//Thanks to Luke Z. for suggesting the Earley parser to me.
//The thing that makes it great for this purpose is that it doesn't have to look at all the non-terminals in the grammar,
//but it still has reasonable time complexity in the size of the input string.
//Earley parser refrences I studied:
//http://en.wikipedia.org/wiki/Earley_parser
//http://www1.icsi.berkeley.edu/~stolcke/papers/cl95/paper-html.html
//https://github.com/tomerfiliba/tau/blob/master/earley3.py
//http://stevehanov.ca/qb.js/EarleyParser.js
//http://www.ling.helsinki.fi/kit/2008s/clt231/nltk-0.9.5/doc/en/ch08.html
//My Earley parser differs from the standard version in it's use of
//node.js's asynchronous capabilities.
//Each token is a pool that the predictions flow through, or something like that.
//I still don't feel like I fully understand it.
module.exports = {
    /**
     * chartToInterpretations converts a parse chart to a tree of langNodes with "interpretations" properties.
     * Interpretations is an array of component arrays.
     *    It might be possible to slightly modify the parse function to generate an interpretation tree more efficiently
     *    however, I don't want to make parse any more complex that it already is at this point.
     *    With some query statistics it could even become possible to further prune the grammer by leaving out
     *    highly imporobable parses.
     */
    chartToInterpretations : function (chart) {
         //Returns an array of interpretations. Each interpretation is a corresponding array of components.
        function processComponents(components, colIdx) {
            var component, langNodeInterps;
            if(components.length === 0 || colIdx <= 0){//colIdx?
                return [[]];
            }
            component = components.slice(-1)[0];
            if('terminal' in component) {
                return _.map(processComponents(components.slice(0, -1), colIdx - component.terminal.length), function(interpretation){
                    return interpretation.concat(component);
                });
            } else if('category' in component) {
                langNodeInterps = _.filter(chart[colIdx], function(langNode) {
                    return (langNode.category === component.category) && langNode.parseData.complete;
                });
                if(langNodeInterps.length === 0 ) return [[]];
                return _.flatten(_.map(langNodeInterps, function(langNodeInterp) {
                    var returnInterp = _.extend({}, langNodeInterp);//TODO: Probably not necessairy.
                    returnInterp.interpretations = processComponents(returnInterp.components, colIdx);
                    return _.map(processComponents(components.slice(0, -1), langNodeInterp.parseData.origin), function(interpretation){
                        //TODO: remove parseData here?
                        return interpretation.concat(returnInterp);
                    });
                }), true);
            } else if('regex' in component) {
                //TODO
            } else {
                throw "Unknown component type:\n" + JSON.stringify(component);
            }
        }
        var interpretationsTree = processComponents([{category : 'GAMMA'}], chart.length - 1)[0][0];
        if(interpretationsTree){
            return _.flatten(interpretationsTree.interpretations, true);
        } else {
            return interpretationsTree;
        }
    },
    parse : function (input, startCategory, collection, callback) {
        if(!input) {
            callback('No input');
            return;
        }
        if(!startCategory) {
            callback('No start category');
            return;
        }
        //Note, an emptystring is added to the end of the input array bc
        //the scanner might try to add things when it's on the last char.
        var splitInput = input.split('').concat(['']);
        console.log(splitInput);
        var chart = _.map(splitInput, function(){
            return [];
        });
        var statePools = [];
        var finishCounter = splitInput.length;
        function finishListener() {
            console.log("finish");
            finishCounter--;
            if(finishCounter <= 0){
                callback(null, chart);
            }
        }
        //This is async.
        function predictor(langNode, j) {
            var currentComponent = langNode.components[langNode.parseData.atComponent];
            //console.log("predictor: category: " + currentComponent.category);
            //I want to know why mongo uses json paths to query nested json objects rather than nested json objects.
            //I suppose it's easier to write queries by hand, but it's so much cleaner when you generate queries in code.
            //I hope they eventually do both.
            collection.find({ 'content.category' : currentComponent.category }).toArray(function(err, array) {
                if (err) throw err;//TODO: Missing categories might be an issue, but perhaps this is only for db errors.
                _.each(array, function(cLangNode){
                    //TODO: Perhaps more stringIdx into terminals and do something similar with regexs
                    cLangNode.parseData = {
                        'atComponent' : 0,
                        'stringIdx' : 0,
                        'origin' : j
                    };

                    //Putting category/components at the top level might make things easier to deal with
                    //if there are nested categories declaired inline in a langNode.json file,
                    //not that I have support for this yet.
                    cLangNode.category = cLangNode.content.category;
                    cLangNode.components = cLangNode.content.components;
                    replaceStringsWithTerminalObjects(cLangNode);
                    statePools[j].emit('add', cLangNode);
                });
                //I'm assuming that emited events happen in order or emission.
                statePools[j].emit('done');
            });
        }
        function terminalScanner(langNode, j) {
            console.log("terminalScanner");
            console.log(langNode);
            var componentString = langNode.components[langNode.parseData.atComponent].terminal;
            if(input[j] === componentString[langNode.parseData.stringIdx]) {
                langNode = Object.create(langNode);
                langNode.parseData = _.clone(langNode.parseData);
                langNode.parseData.stringIdx++;
                if(langNode.parseData.stringIdx >= componentString.length) {
                    langNode.parseData.atComponent++;
                    langNode.parseData.stringIdx = 0;
                    if(langNode.parseData.atComponent >= langNode.components.length) {
                        langNode.parseData.complete = true;
                    }
                }
                statePools[j+1].emit('add', langNode);
            }
            statePools[j].emit('done');
        }
        function regexScanner(langNode, j) {
            console.log("regexScanner");
            console.log(langNode);
            var alwaysEmittedNode, matchEmittedNode;
            var regex = langNode.components[langNode.parseData.atComponent].regex;
            if(j < input.length) {//TODO: Use incremental regexs here to rule out input that can't possibly match.
                alwaysEmittedNode = Object.create(langNode);
                alwaysEmittedNode.parseData = _.clone(langNode.parseData);//Can I use Object.create here? Iff parseData is static?
                alwaysEmittedNode.parseData.stringIdx++;
                statePools[j+1].emit('add', alwaysEmittedNode);
                matchEmittedNode = Object.create(langNode);
                matchEmittedNode.parseData = _.clone(langNode.parseData);//Can I use Object.create here?
                matchEmittedNode.parseData.stringIdx++;
                if(regex.test(input.slice(j + 1 - matchEmittedNode.parseData.stringIdx, j+1))) {
                    matchEmittedNode.parseData.atComponent++;
                    matchEmittedNode.parseData.stringIdx = 0;
                    if(matchEmittedNode.parseData.atComponent >= matchEmittedNode.components.length) {
                        matchEmittedNode.parseData.complete = true;
                    }
                    statePools[j+1].emit('add', matchEmittedNode);
                }
            }
            statePools[j].emit('done');
        }
        //this is probably going to be async cause of the lookback
        function completer(langNode, j) {
            console.log("completer");
            //TODO: This is probably a bug, the chart might not be fully filled out.
            _.each(chart[langNode.parseData.origin], function(originLN, idx) {
                var originComponent = originLN.components[originLN.parseData.atComponent];
                //This assumes we are completing non-terminals.
                if(originComponent.category === langNode.category) {
                    //Make a new state from the origin state
                    originLN = Object.create(originLN);
                    originLN.parseData = _.clone(originLN.parseData);
                    originLN.parseData.atComponent++;
                    if(originLN.parseData.atComponent >= originLN.components.length) {
                        originLN.parseData.complete = true;
                    }
                    statePools[j].emit('add', originLN);
                }
            });
            statePools[j].emit('done');
        }
        _.each(splitInput, function(character, idx) {
            var statePool = new EventEmitter();
            var counter = 0;//counts items remaining the the pool
            var prevPoolFinished = false;
            if(idx > 0){
                statePools[idx-1].on('finish', function(){
                    prevPoolFinished = true;
                    if( counter === 0 ){
                        statePool.emit('empty');
                    }
                });
            } else {
                prevPoolFinished = true;
            }
            statePool.on('finish', finishListener);
            statePool.on('done', function(){
                console.log("done");
                counter--;
                if( counter === 0 ){
                    statePool.emit('empty');
                }
            });
            statePool.on('empty', function(){
                console.log("empty");
                if( prevPoolFinished ){
                    statePool.emit('finish');
                }
            });
            statePool.on('add', function(langNode) {
                console.log("Adding:");
                console.log(_.extend({}, langNode));
                var currentComponent;
                //Make sure the item is unique.
                //TODO: Make unit tested function for node comparison.
                if(_.any(chart[idx], function(item){
                        if(langNode.parseData.atComponent === item.parseData.atComponent){
                            if(langNode.parseData.stringIdx === item.parseData.stringIdx){
                                if(langNode.category === item.category){
                                    return _.isEqual(langNode.components, item.components);
                                }
                            }
                        }
                        return false;
                    })) {
                    console.log("duplicate found");
                    return;
                }
                counter++;
                chart[idx].push(langNode);
                if(!langNode.parseData.complete) {
                    currentComponent = langNode.components[langNode.parseData.atComponent];
                    if('terminal' in currentComponent){
                        terminalScanner(langNode, idx);
                    } else if('category' in currentComponent) { //categories are non-terminals
                        predictor(langNode, idx);
                    } else if('regex' in currentComponent) {
                        regexScanner(langNode, idx);
                    } else {
                        throw "Unknown component type:\n" + JSON.stringify(currentComponent);
                    }
                } else {
                    completer(langNode, idx);
                }
            }); 
            statePools.push(statePool);
        });
        //TODO: Try feeding this into predictor instead so GAMMA doesn't show up in the output.
        statePools[0].emit('add', {
            'category' : 'GAMMA',
            'components' : [{'category' : startCategory}],
            'parseData': {
                'atComponent' : 0,
                'stringIdx' : 0,
                'origin': 0
            }
        });
    }
};