/*
  KeeFox - Allows Firefox to communicate with KeePass (via the KeePassRPC KeePass plugin)
  Copyright 2008-2013 Chris Tomlinson <keefox@christomlinson.name>
  
  The KeeFox object will handle communication with the KeeFox JSON-RPC objects,
  including situations such as partially installed components and KeePass
  not running. The object is mainly concerned with low-level extension 
  functionality rather than user-visible behaviour or actual use of the data
  in the active KeePass database.
  
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

var EXPORTED_SYMBOLS = ["keefox_org"];
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://kfmod/KFLogger.js");
Cu.import("resource://kfmod/metrics.js");
Cu.import("resource://kfmod/jsonrpcClient.js");
Cu.import("resource://kfmod/locales.js");
Cu.import("resource://kfmod/utils.js");
Cu.import("resource://kfmod/KFExtension.js");
Cu.import("resource://kfmod/config.js");
Cu.import("resource://kfmod/commands.js");
Cu.import("resource://kfmod/search.js");

// constructor
function KeeFox()
{
    this._KFLog = KFLog;
    this.utils = utils;

    this.appInfo = Components.classes["@mozilla.org/xre/app-info;1"]
            .getService(Components.interfaces.nsIXULRuntime);
    
    this.os = this.appInfo.OS;
        
    this._keeFoxExtension = KFExtension;
    
    if (this._keeFoxExtension.db.conn.tableExists("meta"))
    {
        var statement = this._keeFoxExtension.db.conn.createStatement("SELECT * FROM meta WHERE id = 1");

        var currentSchemaVersion = 0;
        while (statement.executeStep())
            currentSchemaVersion = statement.row.schemaVersion;

        if (currentSchemaVersion == 1)
        {
            // No actual change to shema for v2 but we're not using this sqlite DB any more, at least for the time being.
            this.listOfNoSavePromptURLsToMigrate = [];

            // find all URLs we want to exclude
            var statement = this._keeFoxExtension.db.conn.createStatement("SELECT * FROM sites WHERE preventSaveNotification = 1");

            // These URLs will be processed by the config object which is initialised after this main constructor executes
            // Combined impact and liklihood of problems with this migration are low enough to just assume everything is OK
            while (statement.executeStep())
                this.listOfNoSavePromptURLsToMigrate.push(statement.row.url);

            var statementMigrateSchemaBump = this._keeFoxExtension.db.conn.createStatement('UPDATE "meta" SET schemaVersion=2 WHERE id=1');
            statementMigrateSchemaBump.execute(); 
            var statementMigrateDrop = this._keeFoxExtension.db.conn.createStatement('DELETE FROM "sites"');
            statementMigrateDrop.execute(); 
        }
    }
    
    this._keeFoxStorage = this._keeFoxExtension.storage;
    
    if (this._keeFoxExtension.firstRun)
    {
        var originalPreferenceRememberSignons = false;
        try {
            originalPreferenceRememberSignons = this._keeFoxExtension.prefs._prefBranchRoot.getBoolPref("signon.rememberSignons");
            } catch (ex) {}
        this._keeFoxExtension.prefs.setValue(
            "signon.rememberSignons", originalPreferenceRememberSignons);
        this._keeFoxExtension.prefs._prefBranchRoot.setBoolPref("signon.rememberSignons", false);
    }
    
    this.locale = new Localisation(["chrome://keefox/locale/keefox.properties"]);
    
    // Set up metrics recording but don't break the main addon if something unexpected happens
    try
    {
        // Most of the metrics manager startup code is asynchronous so there is a
        // race between the manager and the rest of the KeeFox startup code. I
        // think this has been covered in the design of the manager (e.g. with 
        // temporary storage of metrics while the main storage subsystems
        // initialise) but even if I've got that 100% correct, it is a shame to
        // double-handle the activity that occurs before the manager is ready
        // so it may be worth refactoring a few other parts of KeeFox to allow
        // us to start the metrics manager initialisation sooner.
        this.metricsManager = metricsManager;
        let metricsUserId = this._keeFoxExtension.prefs.getValue("metricsUserId", "");
        if (!metricsUserId)
        {
            metricsUserId = this.utils.newGUID();
            this._keeFoxExtension.prefs.setValue("metricsUserId", metricsUserId);
        }
        this.metricsManager.init(this.locale.getCurrentLocale(), metricsUserId, this.utils.newGUID());
    } catch (e) {
        this._KFLog.error("Could not load metrics manager. Creating null functions to minimise disruption.");
        this.metricsManager = {};
        this.metricsManager.pushEvent = function () {};
        this.metricsManager.adjustAggregate = function () {};
        this.metricsManager.setApplicationMetadata = function () {};
    }

    this.search = new Search(this, {
        version: 1
    });

    var observerService = Components.classes["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
    this._observer._kf = this;    
    observerService.addObserver(this._observer, "quit-application", false);   
        
    this._keeFoxExtension.prefs._prefBranchRoot.QueryInterface(Ci.nsIPrefBranch2);
    this._keeFoxExtension.prefs._prefBranchRoot.addObserver("signon.rememberSignons", this._observer, false);
    this._keeFoxExtension.prefs._prefBranchRoot.QueryInterface(Ci.nsIPrefBranch);
    
    this._keeFoxExtension.prefs._prefBranch.QueryInterface(Ci.nsIPrefBranch2);
    this._keeFoxExtension.prefs._prefBranch.addObserver("", this._observer, false);
    this._keeFoxExtension.prefs._prefBranch.QueryInterface(Ci.nsIPrefBranch);
        
    // Create a timer for KPRPC connection establishment
    this.regularKPRPCListenerQueueHandlerTimer = Components.classes["@mozilla.org/timer;1"]
            .createInstance(Components.interfaces.nsITimer);

    this.regularKPRPCListenerQueueHandlerTimer.initWithCallback(
    this.RegularKPRPCListenerQueueHandler, 5000,
    Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);

    // Create a timer for checking whether user is logging sensitive data
    this.oneOffSensitiveLogCheckTimer = Components.classes["@mozilla.org/timer;1"]
            .createInstance(Components.interfaces.nsITimer);

    this.oneOffSensitiveLogCheckTimer.initWithCallback(
    utils.oneOffSensitiveLogCheckHandler, 45000,
    Components.interfaces.nsITimer.TYPE_ONE_SHOT);

    //TODO2: set some/all of my tab session state to be persistent so it survives crashes/restores?
    
    this.lastKeePassRPCRefresh = 0;
    this.ActiveKeePassDatabaseIndex = 0;
    this._keeFoxBrowserStartup();
}

KeeFox.prototype = {

    _keeFoxExtension: null,

    regularKPRPCListenerQueueHandlerTimer: null,
    oneOffSensitiveLogCheckTimer: null,

    // localisation string bundle
    locale: null,
    
    // our logging object (held locally becuase this is a seperate module)
    _KFLog: null,

    // Our link to the JSON-RPC objects required for communication with KeePass
    KeePassRPC: null,
    
    _installerTabLoaded: false,
    treeViewGroupChooser: null,
    
    //callbackQueue: [],
    processingCallback: false,
    pendingCallback: "",
    
    urlToOpenOnStartup: null,
    
    KeePassDatabases: null,
    
    getDBbyFilename: function(fileName)
    {
        this._KFLog.debug("Getting database for filename: " + fileName);
        if (fileName == undefined || fileName == null || fileName.length == 0)
            return this.KeePassDatabases[this.ActiveKeePassDatabaseIndex];
            
        for (var i=0; i < this.KeePassDatabases.length; i++)
        {
            if (this.KeePassDatabases[i].fileName == fileName)
                return this.KeePassDatabases[i];
        }
    },

    shutdown: function()
    {
        // These log messages never appear. Does this function even get executed?
        this._KFLog.debug("KeeFox module shutting down...");
        if (this.KeePassRPC != undefined && this.KeePassRPC != null)
            this.KeePassRPC.shutdown();
        if (this.regularKPRPCListenerQueueHandlerTimer != undefined && this.regularKPRPCListenerQueueHandlerTimer != null)
            this.regularKPRPCListenerQueueHandlerTimer.cancel();
        this.KeePassRPC = null;
        
        this._KFLog.debug("KeeFox module shut down.");
        this._KFLog = null;
    },

    _keeFoxBrowserStartup: function()//currentKFToolbar, currentWindow)
    {        
        //this._KFLog.debug("Testing to see if KeeFox has already been setup (e.g. just a second ago by a different window scope)");
        //TODO2: confirm multi-threading setup. I assume firefox has
        // one event dispatcher thread so seperate windows can't be calling
        // this function concurrently. if that's wrong, need to rethink
        // or at least lock from here onwards
//        if (this._keeFoxStorage.get("KeePassRPCActive", false))
//        {
//            this._KFLog.debug("Setup has already been done but we will make sure that the window that this scope is a part of has been set up to properly reflect KeeFox status");
//            currentKFToolbar.setupButton_ready(currentWindow);
//            currentKFToolbar.setAllLogins();
//            currentWindow.addEventListener("TabSelect", this._onTabSelected, false);
//            return;
//        }

        // Default Mono executable set here rather than hard coding elsewhere
        this.defaultMonoExec = '/usr/bin/mono';
        
        // Centralize this check.
        // Checking only the OS does not allow running Mono under Windows.
        // Therefore, if the user has set a Mono executable location in the prefs, we will
        // assume that they want to run under mono.
        var userHasSetMonoLocation = this._keeFoxExtension.prefs.getValue("monoLocation", "");
        
        if ((this.os != "WINNT") || (userHasSetMonoLocation != ""))
        {
          this.useMono = true;
          utils.useMono = true;
        }
        else
        {
          this.useMono = false;
          utils.useMono = false;
        }

        // Set the baseURL to use for Mono vs Windows
        if (!this.useMono)
        {
          this.baseInstallURL = 'chrome://keefox/content/install.xul';
        }
        else
        {
          this.baseInstallURL = 'chrome://keefox/content/install_mono.xul';
        }
        
        this._KFLog.info("KeeFox initialising");
        
        this._keeFoxVariableInit();
        this.KeePassRPC = new jsonrpcClient();
        if (this._keeFoxExtension.prefs.has("KeePassRPC.port")) {
            this.KeePassRPC.port = this._keeFoxExtension.prefs.getValue(
                "KeePassRPC.port", this.KeePassRPC.port);

            // Don't allow user to select an invalid port
            if (this.KeePassRPC.port <= 0 || this.KeePassRPC.port > 65535 || this.KeePassRPC.port == 12546) {
                this._keeFoxExtension.prefs.setValue("KeePassRPC.port", 12536);
                this.KeePassRPC.port = 12536;
            }
        }
        if (this._keeFoxExtension.prefs.has("KeePassRPC.webSocketPort"))
        {
            this.KeePassRPC.webSocketPort = this._keeFoxExtension.prefs.getValue(
                "KeePassRPC.webSocketPort", this.KeePassRPC.webSocketPort);

            // Don't allow user to select an invalid port
            if (this.KeePassRPC.webSocketPort <= 0 || this.KeePassRPC.webSocketPort > 65535 || this.KeePassRPC.webSocketPort == 12536)
            {
                this._keeFoxExtension.prefs.setValue("KeePassRPC.webSocketPort", 12546);
                this.KeePassRPC.webSocketPort = 12546;
            }
            this.KeePassRPC.webSocketURI = "ws://" + this.KeePassRPC.webSocketHost + ":" + this.KeePassRPC.webSocketPort;
            this.KeePassRPC.httpChannelURI = "http://" + this.KeePassRPC.webSocketHost + ":" + this.KeePassRPC.webSocketPort;
        }

        // start regular attempts to reconnect to KeePassRPC
        // NB: overheads here include a test whether a socket is alive
        // and regular timer scheduling overheads - hopefully that's insignificant
        // but if not we can try more complicated connection strategies
        this.KeePassRPC.reconnectSoon();
        
        this._KFLog.info("KeeFox initialised OK although the connection to KeePass may not be established just yet...");            
    },
        
    _keeFoxVariableInit : function()
    {        
        var KeePassEXEfound;
        var KeePassRPCfound;
        
        var keePassLocation;
        keePassLocation = "not installed";
        var keePassRPCLocation;
        keePassRPCLocation = "not installed";        
        var monoLocation;
        monoLocation = "not installed";        
        
        var keePassRememberInstalledLocation = 
            this._keeFoxExtension.prefs.getValue("keePassRememberInstalledLocation",false);
        if (!keePassRememberInstalledLocation)
        {
            keePassLocation = utils._discoverKeePassInstallLocation();
            if (keePassLocation != "not installed")
            {
                KeePassEXEfound = utils._confirmKeePassInstallLocation(keePassLocation);
                if (KeePassEXEfound)
                {
                    keePassRPCLocation = utils._discoverKeePassRPCInstallLocation();
                    KeePassRPCfound = utils._confirmKeePassRPCInstallLocation(keePassLocation, keePassRPCLocation);
                    if (!KeePassRPCfound)
                        this._keeFoxExtension.prefs.setValue("keePassRPCInstalledLocation",""); //TODO2: set this to "not installed"?
                } else
                {
                    this._keeFoxExtension.prefs.setValue("keePassInstalledLocation",""); //TODO2: set this to "not installed"?
                }
            }

            if (this.useMono)
            {
              monoLocation = utils._discoverMonoLocation(this.defaultMonoExec);
              if (monoLocation != "not installed")
              {
                let monoExecFound = utils._confirmMonoLocation(monoLocation);
                if (!monoExecFound)
                {
                  this._keeFoxExtension.prefs.setValue("monoLocation",""); //TODO2: set this to "not installed"?
                }
              }
              else
              {
                this._keeFoxExtension.prefs.setValue("monoLocation",""); //TODO2: set this to "not installed"?
              }
            }
        }
        
        if (keePassRememberInstalledLocation)
        {
            this._keeFoxStorage.set("KeePassRPCInstalled", true);
        } else
        { 
            this._KFLog.info("Checking and updating KeePassRPC installation settings");

            if (keePassRPCLocation == "not installed")
            {
                this._KFLog.info("KeePassRPC location was not found");
                this._launchInstaller();
            } else
            {
                if ((this.useMono) && (monoLocation == "not installed"))
                {
                  this._KFLog.info("Mono executable not present in expected location");
                  this._launchInstaller();                    
                }
                else if (!KeePassEXEfound)
                {
                    this._KFLog.info("KeePass EXE not present in expected location");
                    this._launchInstaller();
                } else
                {
                    if (!KeePassRPCfound)
                    {
                        this._KFLog.info("KeePassRPC plugin DLL not present in KeePass plugins directory so needs to be installed");
                        this._launchInstaller();
                    } else
                    {
                        this._KFLog.info("KeePass is not running or the connection might be established in a second...");
                        this._keeFoxStorage.set("KeePassRPCInstalled", true);
                    }
                }
            }
        }
    },
    
    // Temporarilly disable KeeFox. Used (for e.g.) when KeePass is shut down.
    _pauseKeeFox: function()
    {
        this._KFLog.debug("Pausing KeeFox.");
        this._keeFoxStorage.set("KeePassRPCActive", false);
        this._keeFoxStorage.set("KeePassDatabaseOpen", false);
        this.KeePassDatabases = null;
        this.ActiveKeePassDatabaseIndex = 0;
        
        var wm = Cc["@mozilla.org/appshell/window-mediator;1"].
                 getService(Ci.nsIWindowMediator);
        var enumerator = wm.getEnumerator("navigator:browser");
        var tabbrowser = null;

        while (enumerator.hasMoreElements())
        {
            try
            {
                var win = enumerator.getNext();
                win.keefox_win.mainUI.removeLogins(); // remove matched logins
                win.keefox_win.mainUI.setAllLogins(); // remove list of all logins
                win.keefox_win.context.removeLogins();
                win.keefox_win.mainUI.setupButton_ready(win);
                win.keefox_win.UI._removeOLDKFNotifications(true);
            } catch (exception)
            {
                this._KFLog.warn("Could not pause KeeFox in a window. Maybe it is not correctly set-up yet? " + exception);
            }
        }
        this.KeePassRPC.disconnect();
        this._KFLog.info("KeeFox paused.");
    },
    
    // This is now intended to be called on all occasions when the toolbar or UI need updating
    // If KeePass is unavailable then this will call _pauseKeeFox instead but
    // it's more efficient to just call the pause function straight away if you know KeePass is disconnected
    
    // called on connect, on startup and on many callbacks from KeePass - a bit of shuffling of the first two situations might
    // leave us in a situation where this can be thought of as only something that happens after a full getallDBs list callback????
    
    //OK, this is now considered a request to refresh, not the actual operation itself...
    _refreshKPDB: function ()
    {
        this._KFLog.debug("Request to refresh KeeFox's view of the KeePass database received.");
    
        this.getAllDatabases();
    
        this._KFLog.debug("Refresh of KeeFox's view of the KeePass database initiated.");    
    },
    
    _refreshKPDBCallback: function ()
    {
        this._KFLog.debug("Refreshing KeeFox's view of the KeePass database.");
        var dbName = this.getDatabaseName();
         if (dbName === null)
        {
            this._KFLog.debug("No database is currently open.");
            this._keeFoxStorage.set("KeePassDatabaseOpen", false);
        } else
        {
            if (this._KFLog.logSensitiveData)
                this._KFLog.info("The '" + dbName + "' database is open and active (maybe more are too).");
            else
                this._KFLog.info("At least one database is open.");
            this._keeFoxStorage.set("KeePassDatabaseOpen", true);
        }
        
        var wm = Cc["@mozilla.org/appshell/window-mediator;1"].
                 getService(Ci.nsIWindowMediator);
        var enumerator = wm.getEnumerator("navigator:browser");
        var tabbrowser = null;

        while (enumerator.hasMoreElements())
        {
            try
            {
                var win = enumerator.getNext();
                win.keefox_win.mainUI.removeLogins();
                win.keefox_win.context.removeLogins();
                win.keefox_win.mainUI.setAllLogins();
                win.keefox_win.mainUI.setupButton_ready(win);
                win.keefox_win.UI._removeOLDKFNotifications();

                if (this._keeFoxStorage.get("KeePassDatabaseOpen",false))
                {
                    win.keefox_win.ILM._fillDocument(win.content.document,false);
                }
            } catch (exception)
            {
                this._KFLog.warn("Could not refresh KeeFox in a window. Maybe it is not correctly set-up yet? " + exception);
            }
        }
        
        //TODO2: this can be done in the getalldatabases callback surely?
        if (this._keeFoxStorage.get("KeePassDatabaseOpen",false) 
            && this._keeFoxExtension.prefs.getValue("rememberMRUDB",false))
        {
            var MRUFN = this.getDatabaseFileName();
            if (MRUFN != null && MRUFN != undefined && !(MRUFN instanceof Error))
                this._keeFoxExtension.prefs.setValue("keePassMRUDB",MRUFN);
        }

        this._KFLog.info("KeeFox feels very refreshed now.");
    },  
    
    updateKeePassDatabases: function(newDatabases)
    {
        var newDatabaseActiveIndex = 0;
        for (var i=0; i < newDatabases.length; i++)
        {
            if (newDatabases[i].active)
            {
                newDatabaseActiveIndex = i;
                break;
            }
        }
        this.KeePassDatabases = newDatabases;
        this.ActiveKeePassDatabaseIndex = newDatabaseActiveIndex;
        if (newDatabases.length > 0)
            this.metricsManager.adjustAggregate("avgOpenDatabases", newDatabases.length);
        this._refreshKPDBCallback();  
    },
    
    
    
    /*******************************************
    / Launching and installing
    /*******************************************/    
    
    launchKeePass: function()
    {
        var fileName = "unknown";
        var args = [];
        let fileNameIsRelative = false;
        
        if (this.useMono)
        {
            // Get location of the mono executable, defaults location of /usr/bin/mono
            fileName = this._keeFoxExtension.prefs.getValue("monoLocation",
                                                            this.defaultMonoExec);

            // Get the users home directory
            var dirService = Components.classes["@mozilla.org/file/directory_service;1"].  
              getService(Components.interfaces.nsIProperties);   
            var homeDirFile = dirService.get("Home", Components.interfaces.nsIFile); // returns an nsIFile object  
            var homeDir = homeDirFile.path;  
            var keepass_exec = "";

            var keepassLoc = this._keeFoxExtension.prefs.getValue("keePassInstalledLocation", "");
            if (keepassLoc == "")
            {
              keepass_exec = homeDir+"/KeePass/KeePass.exe";
            }
            else
            {
              keepass_exec = keepassLoc+"/KeePass.exe";
            }
            
            args.push(keepass_exec);
            
        } else if (!this._keeFoxExtension.prefs.has("keePassInstalledLocation"))
        {
            this._KFLog.error("Could not load KeePass - no keePassInstalledLocation found!");
            return;
        } else
        {
            var directory = this._keeFoxExtension.prefs.getValue("keePassInstalledLocation",
                        "C:\\Program files\\KeePass Password Safe 2\\");

            if (directory.substr(-1) === "\\")
                fileName = directory + "KeePass.exe";
            else
                fileName = directory + "\\KeePass.exe";
        }

        // If user has defined a relative URL, convert it to a format that is valid for use with setRelativeDescriptor
        if (fileName.startsWith('.\\') || fileName.startsWith('..\\'))
            fileName = fileName.replace('\\', '/', 'g');
        if (fileName.startsWith('./') || fileName.startsWith('../'))
        {
            if (fileName.startsWith('./'))
                fileName = fileName.substr(2);
            fileNameIsRelative = true;
        }

        let portParam = "", portLegacyParam = "";

        if (this._keeFoxExtension.prefs.has("KeePassRPC.port"))
        {
            // User interface only allows the web socket port to be configured now but 
            // the legacy port may have been customised in an earlier version of KeeFox
            portLegacyParam = "-KeePassRPCPort:" +
                this._keeFoxExtension.prefs.getValue("KeePassRPC.port",12536);
        }
        if (this._keeFoxExtension.prefs.has("KeePassRPC.webSocketPort"))
        {
            portParam += "-KeePassRPCWebSocketPort:" +
                this._keeFoxExtension.prefs.getValue("KeePassRPC.webSocketPort",12546);
                //TODO:port 0
        }
        var mruparam = this._keeFoxExtension.prefs.getValue("keePassDBToOpen","");
        if (mruparam == "")
            mruparam = this._keeFoxExtension.prefs.getValue("keePassMRUDB","");

        if (portLegacyParam != "")
            args.push(portLegacyParam);
        if (portParam != "")
            args.push(portParam);
        if (mruparam != "")
        {
            args.push("-iocredfromrecent");
            args.push('' + mruparam + '');
        }

        var file = Components.classes["@mozilla.org/file/local;1"]
                   .createInstance(Components.interfaces.nsILocalFile);
        if (fileNameIsRelative) {
            var ffDir = Components.classes["@mozilla.org/file/directory_service;1"]
                        .getService(Components.interfaces.nsIProperties)
                        .get("CurProcD", Components.interfaces.nsIFile);
            // recent FF versions don't have a valid variable to represent
            // "installation location" so this is the best we can do
            if (ffDir.leafName == "browser")
                ffDir = ffDir.parent;

            file.setRelativeDescriptor(ffDir, fileName);
        } else
        {
            file.initWithPath(fileName);
        }

        this._KFLog.info("About to execute: " + file.path + " " + args.join(' '));
        
        var process = Components.classes["@mozilla.org/process/util;1"]
                      .createInstance(Components.interfaces.nsIProcess);
        process.init(file);

        // Run the application (including support for Unicode characters in the path)
        process.runw(false, args, args.length);
    },   
    
    runAnInstaller: function (fileName, params, callback)
    {
        var args = [fileName, params];                
        var file = Components.classes["@mozilla.org/file/local;1"]
                   .createInstance(Components.interfaces.nsILocalFile);
        file.initWithPath(this.utils.myDepsDir() + "\\KeeFoxElevate.exe");

        var process = Components.classes["@mozilla.org/process/util;1"]
                      .createInstance(Components.interfaces.nsIProcess2 || Components.interfaces.nsIProcess);
                      
        this._KFLog.info("about to execute: " + file.path + " " + args.join(' '));
        process.init(file);
        
        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                .getService(Components.interfaces.nsIWindowMediator);
        var win = wm.getMostRecentWindow("navigator:browser") ||
            wm.getMostRecentWindow("mail:3pane");
        
        // Run the application (including support for Unicode characters in the path)
        if (callback == undefined || callback == null)
        {
            process.runw(true,args,2);
        } else
        {
            process.runwAsync(args, 2, callback);
        }
    },

    _launchInstaller: function(currentKFToolbar,currentWindow, upgrade, currentVersion, ourVersion)
    {
        if (this._installerTabLoaded)
            return; // only want to do this once per session to avoid irritation!
        
        this._installerTabLoaded = true;
        
        if (upgrade)
        {
            let upgradeDetails = "";
            this._KFLog.info("KeeFox not installed correctly. Going to try to launch the upgrade page.");
            if (currentVersion && ourVersion)
                upgradeDetails = "&downWarning=1&currentKPRPCv="+currentVersion+"&newKPRPCv="+ourVersion;
            let installTab = this.utils._openAndReuseOneTabPerURL(this.baseInstallURL+"?upgrade=1" + upgradeDetails);
        } else
        {
            this._KFLog.info("KeeFox not installed correctly. Going to try to launch the install page.");
            let installTab = this.utils._openAndReuseOneTabPerURL(this.baseInstallURL);
        }
        
        //NB: FF < 3.0.5 may fail to open the tab due to bug where "session loaded" event fires too soon.
        
        // remember the installation state (until it might have changed...)
        this._keeFoxStorage.set("KeePassRPCInstalled", false);
    },
    
    // if the MRU database is known, open that but otherwise send empty string which will cause user
    // to be prompted to choose a DB to open
    loginToKeePass: function()
    {
        var databaseFileName = this._keeFoxExtension.prefs.getValue("keePassDBToOpen","");
        if (databaseFileName == "")
            databaseFileName = this._keeFoxExtension.prefs.getValue("keePassMRUDB","");

        this.changeDatabase(databaseFileName, true);
    },    
    
    KeeFox_MainButtonClick_install: function(event, temp) {
        this._KFLog.debug("install button clicked. Loading (and focusing) install page.");
        let installTab = this.utils._openAndReuseOneTabPerURL(this.baseInstallURL);
        // remember the installation state (until it might have changed...)
        this._keeFoxStorage.set("KeePassRPCInstalled", false);
    },
    
    _authenticate: function()
    {
        try
        {
            this.KeePassRPC.onNotify("transport-status-connected");              
            return;
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    /*******************************************
    / These functions are essentially wrappers for the actions that
    / KeeFox needs to take against KeePass via the KeePassRPC plugin connection.
    /*******************************************/
    
    getDatabaseName: function(index)
    {
        if (index == undefined)
            index = this.ActiveKeePassDatabaseIndex;
        if (this.KeePassDatabases != null && this.KeePassDatabases.length > 0 
            && this.KeePassDatabases[index] != null 
            && this.KeePassDatabases[index].root != null)
            return this.KeePassDatabases[index].name;
        else
            return null;
    },
    
    getDatabaseFileName: function(index)
    {
        if (index == undefined)
            index = this.ActiveKeePassDatabaseIndex;
        if (this.KeePassDatabases != null && this.KeePassDatabases.length > 0 
            && this.KeePassDatabases[index] != null 
            && this.KeePassDatabases[index].root != null)
            return this.KeePassDatabases[index].fileName;
        else
            return null;
    },
    
    getAllDatabaseFileNames: function()
    {
        try
        {
            return this.KeePassRPC.getMRUdatabases({});
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
        return "";
    },
    
    changeDatabase: function(fileName, closeCurrent)
    {
        try
        {
            this.KeePassRPC.changeDB(fileName, closeCurrent);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    changeLocation: function(locationId)
    {
        try
        {
            this.KeePassRPC.changeLocation(locationId);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    addLogin: function(login, parentUUID, dbFileName)
    {
        try
        {
            return this.KeePassRPC.addLogin(login, parentUUID, dbFileName);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    addGroup: function(title, parentUUID)
    {
        try
        {
            return this.KeePassRPC.addGroup(title, parentUUID);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    removeLogin: function (uniqueID)
    {
        try
        {
            return this.KeePassRPC.deleteLogin(uniqueID);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    removeGroup: function (uniqueID)
    {
        try
        {
            return this.KeePassRPC.deleteGroup(uniqueID);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    getParentGroup: function(uniqueID)
    {
        try
        {
            return this.KeePassRPC.getParentGroup(uniqueID);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    modifyLogin: function (oldLogin, newLogin)
    {
        try
        {
            return this.KeePassRPC.modifyLogin(oldLogin, newLogin);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    getAllDatabases: function ()
    {
        try
        {
            return this.KeePassRPC.getAllDatabases();
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },

    getApplicationMetadata: function ()
    {
        try
        {
            return this.KeePassRPC.getApplicationMetadata();
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },

    findLogins: function(fullURL, formSubmitURL, httpRealm, uniqueID, dbFileName, freeText, username, callback, callbackData)
    {
        try
        {
            return this.KeePassRPC.findLogins(fullURL, formSubmitURL, httpRealm, uniqueID, dbFileName, freeText, username, callback, callbackData);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    launchLoginEditor: function(uuid, dbFileName)
    {
        try
        {
            this.KeePassRPC.launchLoginEditor(uuid, dbFileName);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },

    launchGroupEditor: function(uuid, dbFileName)
    {
        try
        {
            this.KeePassRPC.launchGroupEditor(uuid, dbFileName);
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },

    generatePassword: function()
    {
        try
        {
            return this.KeePassRPC.generatePassword();
        } catch (e)
        {
            this._KFLog.error("Unexpected exception while connecting to KeePassRPC. Please inform the KeeFox team that they should be handling this exception: " + e);
            throw e;
        }
    },
    
    
    _observer :
    {
        _kf : null,

        QueryInterface : XPCOMUtils.generateQI([Ci.nsIObserver, 
                                                Ci.nsISupportsWeakReference]),
        // nsObserver
        observe : function (subject, topic, data)
        {
            var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                                       .getService(Components.interfaces.nsIWindowMediator);
            var window = wm.getMostRecentWindow("navigator:browser") ||
                         wm.getMostRecentWindow("mail:3pane");

            // sometimes this can be null when this function is called (e.g. during window startup)
            if (window == undefined || window == null
                || window.keefox_org == undefined || window.keefox_org == null)
                return;
            window.keefox_org._KFLog.debug("Observed an event: " + subject + "," + topic + "," + data);

            switch(topic)
            {
                case "quit-application":
                    window.keefox_org._KFLog.info("Application is shutting down...");
                    window.keefox_org.shutdown();
                    window.keefox_org._KFLog.info("KeeFox has nearly shut down.");
                    var observerService = Cc["@mozilla.org/observer-service;1"].
                                  getService(Ci.nsIObserverService);
                    observerService.removeObserver(this, "quit-application");
                    
                    this._prefBranchRoot.QueryInterface(Ci.nsIPrefBranch2);
                    this._prefBranchRoot.removeObserver("signon.rememberSignons", this);
                    
                    window.keefox_org._KFLog.info("KeeFox has shut down. Sad times; come back soon!");
                    break;
                case "nsPref:changed":
                    var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                                       .getService(Components.interfaces.nsIWindowMediator);
                    var window = wm.getMostRecentWindow("navigator:browser") ||
                        wm.getMostRecentWindow("mail:3pane");

                    // get a reference to the prompt service component.
                    var promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                                    .getService(Components.interfaces.nsIPromptService);
                    subject.QueryInterface(Components.interfaces.nsIPrefBranch);
                    
                    this.preferenceChangeResponder(subject, data, window, promptService);
                    break;
            }          
        },
        
        preferenceChangeResponder : function (prefBranch, prefName, window, promptService)
        {
            switch (prefName)
            {
                case "signon.rememberSignons":
                //TODO2: Only respond if it's the root pref branch
                    var newValue = prefBranch.getBoolPref(prefName);
                    var flags = promptService.BUTTON_POS_0 * promptService.BUTTON_TITLE_YES +
                        promptService.BUTTON_POS_1 * promptService.BUTTON_TITLE_NO;

                    if (newValue && promptService.confirmEx(window, "Password management",
                        "The KeeFox add-on may not work correctly if you allow"
                        + " Firefox to manage your passwords. Should KeeFox disable"
                        + " the built-in Firefox password manager?",
                               flags, "", "", "", null, {}) == 0)
                    {
                      prefBranch.setBoolPref("signon.rememberSignons", false);
                    }
                    break;
                case "logLevel":
                case "logMethodAlert":
                case "logMethodFile":
                case "logMethodConsole":
                case "logMethodStdOut":
                case "logSensitiveData":
                    // Allow the change to go ahead but warn the user (in case they did not understand the change that was made)
                    window.keefox_org._KFLog.configureFromPreferences();
                    utils.oneOffSensitiveLogCheckHandler();
                    break;
//                case "dynamicFormScanning":
//                    //cancel any current refresh timer (should we be doing this at other times too such as changing tab?
//                    if (keefox_org._keeFoxExtension.prefs.getValue("dynamicFormScanning",false))
//                        window.keefox_org.ILM._refillTimer.init(window.keefox_win.ILM._domEventListener, 2500, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
//                    else
//                        window.keefox_org.ILM._refillTimer.cancel();
//                    break;
                case "currentLocation":
                    //tell KeePass this has changed
                    keefox_org.changeLocation(keefox_org._keeFoxExtension.prefs.getValue("currentLocation",false));
                    break;
                case "maxMatchedLoginsInMainPanel":
                    //recalculate matched logins so current results match user's new preference
                    window.keefox_win.mainUI.setLogins(null,null);
                    keefox_org.commandManager.actions.detectForms();
                    break;
            }
        },
        
        notify : function (subject, topic, data) { }
    },

    // Could use multiple callback functions but just one keeps KeePassRPC simpler
    // this is only called once no matter how many windows are open. so functions
    // within need to handle all open windows for now, that just means every
    // window although in future maybe there could be a need to store a list of
    // relevant windows and call those instead
    KPRPCListener: function(sig)
    {
        var sigTime = Date();
        
        keefox_org._KFLog.debug("Signal received by KPRPCListener (" + sig + ") @" + sigTime);
        
        var executeNow = false;
        var pause = false;
        var refresh = false;
        
        switch (sig) {
            case "0": keefox_org._KFLog.info("KeePassRPC is requesting authentication."); keefox_org._authenticate(); break;
            case "3": keefox_org._KFLog.info("KeePass' currently active DB is about to be opened."); break;
            case "4": keefox_org._KFLog.info("KeePass' currently active DB has just been opened.");
                refresh = true;
                break;
            case "5": keefox_org._KFLog.info("KeePass' currently active DB is about to be closed."); break;
            case "6": keefox_org._KFLog.info("KeePass' currently active DB has just been closed."); 
                refresh = true;
                break;
            case "7": keefox_org._KFLog.info("KeePass' currently active DB is about to be saved."); break;
            case "8": keefox_org._KFLog.info("KeePass' currently active DB has just been saved."); 
                refresh = true;
                break;
            case "9": keefox_org._KFLog.info("KeePass' currently active DB is about to be deleted."); break;
            case "10": keefox_org._KFLog.info("KeePass' currently active DB has just been deleted."); break;
            case "11": keefox_org._KFLog.info("KeePass' active DB has been changed/selected."); 
                refresh = true;
                break;
            case "12": keefox_org._KFLog.info("KeePass is shutting down."); 
                pause = true;
                break;
            default: keefox_org._KFLog.error("Invalid signal received by KPRPCListener (" + sig + ")"); break;
        }
        
        if (!pause && !refresh)
            return;
            
        var now = (new Date()).getTime();
        
        // avoid refreshing more frequently than every half second
//        if (refresh && keefox_org.lastKeePassRPCRefresh > now-5000)
//        {    
//            keefox_org._KFLog.info("Signal ignored. @" + sigTime);
//            return;
//        }
        
        // If there is nothing in the queue at the moment we can process this callback straight away
        if (!keefox_org.processingCallback && keefox_org.pendingCallback == "")
        {
            keefox_org._KFLog.debug("Signal executing now. @" + sigTime); 
            keefox_org.processingCallback = true;
            executeNow = true;
        }
        // Otherwise we need to add the action for this callback to a queue and leave it up to the regular callback processor to execute the action
        
        // if we want to pause KeeFox then we do it immediately or make sure it's the next (and only) pending task after the current task has finished
        if (pause)
        {
            
            if (executeNow) keefox_org._pauseKeeFox(); else keefox_org.pendingCallback = "_pauseKeeFox";
        }
        
        if (refresh)
        {
            
            if (executeNow) {keefox_org.lastKeePassRPCRefresh = now; keefox_org._refreshKPDB();} else keefox_org.pendingCallback = "_refreshKPDB";
        }
        
        keefox_org._KFLog.info("Signal handled or queued. @" + sigTime); 
        if (executeNow)
        {
            
            //trigger any pending callback handler immediately rather than waiting for the timed handler to pick it up
            if (keefox_org.pendingCallback=="_pauseKeeFox")
                keefox_org._pauseKeeFox();
            else if (keefox_org.pendingCallback=="_refreshKPDB")
                keefox_org._refreshKPDB();
            else
                keefox_org._KFLog.info("A pending signal was found and handled.");
            keefox_org.pendingCallback = "";
            keefox_org.processingCallback = false;
            keefox_org._KFLog.info("Signal handled. @" + sigTime); 
        }
    },
    
    RegularKPRPCListenerQueueHandler: function()
    {
        // If there is nothing in the queue at the moment or we are already processing a callback, we give up for now
        if (keefox_org.processingCallback || keefox_org.pendingCallback == "")
            return;
            
        keefox_org._KFLog.debug("RegularKPRPCListenerQueueHandler will execute the pending item now");
        keefox_org.processingCallback = true;
        if (keefox_org.pendingCallback=="_pauseKeeFox")
            keefox_org._pauseKeeFox();
        else if (keefox_org.pendingCallback=="_refreshKPDB")
            keefox_org._refreshKPDB();
        keefox_org.pendingCallback = "";
        keefox_org.processingCallback = false;
        keefox_org._KFLog.debug("RegularKPRPCListenerQueueHandler has finished executing the item");
    },

    _onTabOpened: function(event)
    {
    //event.target.ownerDocument.defaultView.keefox_win.Logger.debug("_onTabOpened.");

    },

//TODO2: this seems the wrong place for this function - needs to be in a window-specific section such as KFUI or KFILM?
    _onTabSelected: function(event)
    {
        var kfw = event.target.ownerDocument.defaultView.keefox_win;
        
        if (kfw.Logger.logSensitiveData)
            kfw.Logger.debug("_onTabSelected:" + kfw.ILM._loadingKeeFoxLogin);
        else
            kfw.Logger.debug("_onTabSelected.");
        
        if (kfw.ILM._loadingKeeFoxLogin != undefined
        && kfw.ILM._loadingKeeFoxLogin != null)
        {
            kfw.ILM._loadingKeeFoxLogin = null;
        } else
        {
            if (kfw.ILM._kf._keeFoxStorage.get("KeePassDatabaseOpen", false))
            {
                // Notify all parts of the UI that might need to clear old matched logins data
//                let observ = Components.classes["@mozilla.org/observer-service;1"]
//                            .getService(Components.interfaces.nsIObserverService);
//                let subject = {logins:null,uri:null};
//                subject.wrappedJSObject = subject;
//                observ.notifyObservers(subject, "keefox_matchedLoginsChanged", null);
                kfw.mainUI.removeLogins();
                kfw.ILM._fillAllFrames(event.target.linkedBrowser.contentWindow,false);

                var topDoc = event.originalTarget.linkedBrowser.contentDocument;
                    if (topDoc.defaultView.frameElement)
                        while (topDoc.defaultView.frameElement)
                            topDoc=topDoc.defaultView.frameElement.ownerDocument;

                event.target.ownerDocument.defaultView.keefox_org._checkRescanForAllFrames(topDoc.defaultView, kfw, topDoc);
            }
        }
    },
    
    // This checks every frame within the document in the selected tab but it needs to store the URL of the topmost tab so that detection of changed URIs will work correctly.
    _checkRescanForAllFrames: function (win, kfw, topDoc)
    {
        kfw.Logger.debug("_checkRescanForAllFrames start");
        var conf = keefox_org.config.getConfigForURL(win.content.document.documentURI);
        
        //TODO1.5: shared code with KFILM.js? refactor?
                
        if (conf.rescanFormDelay >= 500)
        {
            // make sure a timer is running
                kfw.ILM._refillTimer.cancel();
                kfw.ILM._refillTimer.init(kfw.ILM._domEventListener, conf.rescanFormDelay, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
                kfw.ILM._refillTimerURL = topDoc.documentURI;
        } else // We don't want to scan for new forms reguarly
        {
            // but we'll only cancel the existing timer if we're definitley now on a new page
            // I.e. this is the first frame we've looked at on a new tab
            if (kfw.ILM._refillTimerURL != topDoc.documentURI)
            {
                kfw.ILM._refillTimer.cancel();
                //TODO1.5: do we need to store the url of the document we have decided we aren't interested in? Might protect against a problem with tabbing to and from different instances of the same website?
            }
        }
    
        if (win.frames.length > 0)
        {
            kfw.Logger.debug("check Rescan For " + win.frames.length + " sub frames");
            var frames = win.frames;
            for (var i = 0; i < frames.length; i++)
                if (win.keefox_org) //TODO1.3: Not sure why this is sometimes undefined. Rescan may be failing unexpectedly.
                    win.keefox_org._checkRescanForAllFrames(frames[i], kfw, topDoc);
        }    
    },
    
    loadFavicon: function(url, faviconLoader)
    {
        try
        {
        
            var ioservice = Components.classes["@mozilla.org/network/io-service;1"]
                .getService(Components.interfaces.nsIIOService);
                
            var pageURI = ioservice.newURI(url, null, null);

            var faviconService = 
                Components.classes["@mozilla.org/browser/favicon-service;1"]
                    .getService(Components.interfaces.nsIFaviconService);

            try
            {
                // find out if we can used the new async service
                faviconService = faviconService.QueryInterface(Components.interfaces.mozIAsyncFavicons);

                faviconService.getFaviconDataForPage(pageURI,faviconLoader);
                return;
            } catch (e)
            {
                // We couldn't make the new async service work so make sure the fall back is using the correct interface
                faviconService = faviconService.QueryInterface(Components.interfaces.nsIFaviconService);

                if (this._KFLog.logSensitiveData)
                    this._KFLog.info("favicon async load failed for " + url + " : " + e);
                else
                    this._KFLog.info("favicon async load failed : " + e);
            }

        
            try
            {
                var favIconURI = faviconService.getFaviconForPage(pageURI);
            } catch (e)
            {
                // exception means that we couldn't find a favicon
                faviconLoader.onComplete(null,0,null,null);     
            }
            if (!faviconService.isFailedFavicon(favIconURI))
            {
                var datalen = {};
                var mimeType = {};
                try {
                var data = faviconService.getFaviconData(favIconURI, mimeType, datalen);
                faviconLoader.onComplete(favIconURI,datalen,data,mimeType);                
                } catch (e)
                {
                    // exception means that we couldn't find a favicon
                    faviconLoader.onComplete(favIconURI,0,null,null);     
                }
            }
            if (this._KFLog.logSensitiveData)
                throw "We couldn't find a favicon for this URL: " + url;
            else
                throw "We couldn't find a favicon";
        } catch (ex) 
        {
            // something failed so we can't get the favicon. We don't really mind too much...
            faviconLoader.onComplete(null,0,null,null);
            if (this._KFLog.logSensitiveData)
            {
                this._KFLog.info("favicon load failed for " + url + " : " + ex);
                throw "We couldn't find a favicon for this URL: " + url + " BECAUSE: " + ex;
            } else
            {
                this._KFLog.info("favicon load failed: " + ex);
                throw "We couldn't find a favicon BECAUSE: " + ex;
            }
        }
    },

    onSearchCompleted: function (results)
    {
        // a default search results handler. In practice I expect that each search 
        // execution will want to supply its own callback but this might be useful 
        // if we find it neater to integrate with an Observer pattern, etc.
    }
};

var keefox_org = new KeeFox;

// abort if we find a conflict
if (!utils._checkForConflictingExtensions())
    keefox_org = null;

var launchGroupEditorThread = function(uuid) {
  this.uniqueID = uuid;
};

launchGroupEditorThread.prototype = {
  run: function() {
    try {
      keefox_org.KeePassRPC.launchGroupEditor(this.uniqueID);
   
    } catch(err) {
      dump(err);
    }
  },
  
  QueryInterface: function(iid) {
    if (iid.equals(Components.interfaces.nsIRunnable) ||
        iid.equals(Components.interfaces.nsISupports)) {
            return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
};


var launchLoginEditorThread = function(uuid) {
  this.uniqueID = uuid;
};

launchLoginEditorThread.prototype = {
  run: function() {
    try {
      keefox_org.KeePassRPC.launchLoginEditor(this.uniqueID);
  
    } catch(err) {
      dump(err);
    }
  },
  
  QueryInterface: function(iid) {
    if (iid.equals(Components.interfaces.nsIRunnable) ||
        iid.equals(Components.interfaces.nsISupports)) {
            return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
};

// attach our utils so it can be called from outside this module
keefox_org.utils = utils;

    
// initialise the per-site configuration
keefox_org.config = KFConfig;
keefox_org.config.load();

// migrate old data if needed
if (keefox_org.listOfNoSavePromptURLsToMigrate != null && keefox_org.listOfNoSavePromptURLsToMigrate.length > 0)
    keefox_org.config.migrateListOfNoSavePromptURLs(keefox_org.listOfNoSavePromptURLsToMigrate);

if (keefox_org._keeFoxExtension.prefs.has("dynamicFormScanning"))
{
    keefox_org.config.migrateRescanFormTimeFromFFPrefs(keefox_org._keeFoxExtension.prefs.getValue("dynamicFormScanning",false));
    keefox_org._keeFoxExtension.prefs._prefBranch.clearUserPref("dynamicFormScanning");
}

// initialise the command system
keefox_org.commandManager = KFCommands;
keefox_org.commandManager.init(keefox_org.locale);
