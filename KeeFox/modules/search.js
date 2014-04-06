/*
  KeeFox - Allows Firefox to communicate with KeePass (via the KeePassRPC KeePass plugin)
  Copyright 2008-2014 Chris Tomlinson <keefox@christomlinson.name>

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/
"use strict";

let Cc = Components.classes;
let Ci = Components.interfaces;
let Cu = Components.utils;

var EXPORTED_SYMBOLS = ["Search"];
Cu.import("resource://kfmod/KFLogger.js");

// constructor
function Search(keefox_org, config)
{
    this._keefox_org = keefox_org;

    this._KFLog = KFLog;

    if (!config)
        config = {};
    else
    {
        if (config.version != 1)
            KFLog.warn("Unknown search config version. Will use version 1 defaults");
    }

    this._config = {
        // KeeFox will check the supplied version number and behave consistently 
        // for each version, regardless of the current KeeFox addon version.
        // If you supply a config object, you must at least include this property
        version: 1,
        
        // Whether to search all logged in databases or just the active one
        // (generally will want to respect the KeeFox option with this name)
        searchAllDatabases: true,

        // Disable searching in some parts of the entries if required
        searchTitles: (typeof config.searchTitles !== "undefined" ? config.searchTitles : true),
        searchUsernames: (typeof config.searchUsernames !== "undefined" ? config.searchUsernames : true),
        searchGroups: (typeof config.searchGroups !== "undefined" ? config.searchGroups : true),
        searchURLs: (typeof config.searchURLs !== "undefined" ? config.searchURLs : true),
    
        // Custom weights allow the order of results to be manipulated in a way
        // that best fits the context in which those results will be displayed
        weightTitles: config.weightTitles || 2,
        weightUsernames: config.weightUsernames || 1,
        weightGroups: config.weightGroups || 0.25,
        weightURLs: config.weightURLs || 0.75,
    
        // not needed once implementation updated for version 1?
        matchMask: 1031,
    
        // Include a callback function if you want to run the search asynchronously, if
        // omitted the search will block and return the full set of results.
        // You can also set a unique callback for each call: Search.execute(query, useThisCallbackInstead);
        onComplete: config.onComplete,
    
        // A callback function to handle an individual result. Whatever is
        // returned from this optional function will be added to the list of complete results
        onMatch: config.onMatch
    
    };
    this.validateConfig();
    
        //TODO: Check KF is in valid state for searching and validate incoming params

}

Search.prototype = {

    configIsValid: false,
    makeAsyncTimer: null,

    reconfigure: function (config)
    {
        return this.validateConfig();
    },

    execute: function(query, onComplete)
    {
        let abort = false;

        if (!this.configIsValid)
        {
            KFLog.error("You can't execute a search while the search configuration is invalid. Please fix it by calling reconfigure().");
            abort = true;
        }

        if (!query || query.length == 0)
            abort = true;

        if (this._keefox_org.KeePassDatabases.length == 0)
            abort = true;

        onComplete = onComplete || this._config.onComplete;

        if (abort)
        {
            if (onComplete)
            {
                onComplete([]);
                return;
            } else
            {
                return [];
            }
        }

        var results = [];
        function addResult(result) {
			if (this._config.onMatch)
            {
                result = this._config.onMatch(result);
                if (result)
                    results.push(result);
            }
            else
                results.push(result);
		};

        // allow pre-tokenised search terms to be supplied
        let keywords;
        if (Array.isArray(query))
            keywords = query;
        else
            keywords = this.tokenise(query);

        function actualSearch ()
        {
            if (this._config.searchAllDatabases)
            {
                for (let i=0; i<this._keefox_org.KeePassDatabases.length; i++)
                {
                    let root = this._keefox_org.KeePassDatabases[i].root;
		            this.treeTraversal(root, '', false, keywords, addResult.bind(this));
                }
            } else
            {
                let root = this._keefox_org.KeePassDatabases[this._keefox_org.ActiveKeePassDatabaseIndex].root;
		        this.treeTraversal(root, '', false, keywords, addResult.bind(this));
            }
            onComplete(results);
        }

        if (onComplete)
        {
            // Create a timer to make the search run async
            this.makeAsyncTimer = Components.classes["@mozilla.org/timer;1"]
                    .createInstance(Components.interfaces.nsITimer);
            this.makeAsyncTimer.initWithCallback(
            actualSearch.bind(this), 1, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
            //TODO2: use a background worker instead?
            return;
        } else
        {
            actualSearch.call(this);
            return results;
        }
    },

    validateConfig: function ()
    {
        this.configIsValid = true;

        if (this._config.version != 1)
        {
            KFLog.warn("Unknown config version");
            this.configIsValid = false;
        }

        if (this._config.searchAllDatabases !== true && this._config.searchAllDatabases !== false)
        {
            KFLog.warn("searchAllDatabases should be a boolean");
            this.configIsValid = false;
        }

        if (this._config.searchTitles !== true && this._config.searchTitles !== false)
        {
            KFLog.warn("searchTitles should be a boolean");
            this.configIsValid = false;
        }

        if (this._config.searchUsernames !== true && this._config.searchUsernames !== false)
        {
            KFLog.warn("searchUsernames should be a boolean");
            this.configIsValid = false;
        }

        if (this._config.searchGroups !== true && this._config.searchGroups !== false)
        {
            KFLog.warn("searchGroups should be a boolean");
            this.configIsValid = false;
        }

        if (this._config.searchURLs !== true && this._config.searchURLs !== false)
        {
            KFLog.warn("searchURLs should be a boolean");
            this.configIsValid = false;
        }

        if (isNaN(this._config.weightTitles) || this._config.weightTitles <= 0)
        {
            KFLog.warn("weightTitles should be a positive number");
            this.configIsValid = false;
        }

        if (isNaN(this._config.weightUsernames) || this._config.weightUsernames <= 0)
        {
            KFLog.warn("weightUsernames should be a positive number");
            this.configIsValid = false;
        }

        if (isNaN(this._config.weightGroups) || this._config.weightGroups <= 0)
        {
            KFLog.warn("weightGroups should be a positive number");
            this.configIsValid = false;
        }

        if (isNaN(this._config.weightURLs) || this._config.weightURLs <= 0)
        {
            KFLog.warn("weightURLs should be a positive number");
            this.configIsValid = false;
        }

        if (this._config.onComplete != null && typeof(this._config.onComplete) !== 'function')
        {
            KFLog.warn("onComplete should be a function (or ommitted)");
            this.configIsValid = false;
        }

        if (this._config.onMatch != null && typeof(this._config.onMatch) !== 'function')
        {
            KFLog.warn("onMatch should be a function (or ommitted)");
            this.configIsValid = false;
        }
    
        return this.configIsValid;
    },
    
    tokenise: function(text) {
		var tokens = text.match(/'[^']*'|"[^"]*"|[^\s ]+/g) || [];
		tokens.forEach(function(value, index, array) {
			array[index] = array[index].replace(/(^['"])|(['"]$)/g, '')
				.replace(/[\s ]+/g, ' ')
				.toLowerCase();
		});
		return tokens;
	},

	isMatched: function(item, keywords) {
		var attributes = ['url', 'username', 'title'];
		
        //Sometimes the attribute is not found. This try catch is a quick
        // hack to skip the result and keep things moving in the POC.
        try
        {
            NEXT:
		    for (var keyword of keywords) {
			    for (var j = 0; j < attributes.length; j++) {
				    if ((((this._config.matchMask >>> j) % 2) == 1) && (item[attributes[j]].toLowerCase().indexOf(keyword) > -1)) {
					    continue NEXT;
				    }
			    }
			    return false;
		    }
        } catch (e)
        {
            return false;
        }
		return true;
	},

	convertItem: function(path, node, url) {
		var item = new Object();
		
        //if (! url) {
        // What's the point of this block?
		//	item.title = path + '/' + node.title;
		//	item.url = item.user = '';
		//} else {
			item.iconImageData = node.iconImageData;
			item.usernameValue = node.usernameValue;
            item.usernameName = node.usernameName;
			item.path = path;
			item.title = node.title;
			item.url = url;
            item.uniqueID = node.uniqueID;
		//}
		return item;
	},

    /* TODO: track total results found and abort early when display limit reached
        */
	treeTraversal: function(branch, path, flag, keywords, addResult) {
		for (var leaf of branch.childLightEntries) {
			for (var url of leaf.uRLs) {
				var item = this.convertItem(path, leaf, url);
				(flag || this.isMatched(item, keywords)) && (addResult(item));
			}
		}
		for (var subBranch of branch.childGroups) {
			var subFlag = (flag) || (((this._config.matchMask >>> 10) % 2) == 1) && (this.isMatched(this.convertItem(path, subBranch, null), keywords));
			this.treeTraversal(subBranch, path + '/' + subBranch.title, subFlag, keywords, addResult);
		}
	}
};