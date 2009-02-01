/*
  KeeFox - Allows Firefox to communicate with KeePass (via the KeeICE KeePass-plugin)
  Copyright 2008 Chris Tomlinson <keefox@christomlinson.name>
  
  This KFToolBar.js file contains functions and data related to the visible
  toolbar that the XUL defines. In future, we may make this deal in terms of
  individual buttons rather than a rigid toolbar.
  
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

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

function KFToolbar(currentWindow) {
    this._currentWindow = currentWindow;
}

KFToolbar.prototype = {

    _currentWindow : null,
    
    _alert : function (msg) {
        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                           .getService(Components.interfaces.nsIWindowMediator);
        var window = wm.getMostRecentWindow("navigator:browser");

        // get a reference to the prompt service component.
        var promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                            .getService(Components.interfaces.nsIPromptService);

        // show an alert. For the first argument, supply the parent window. The second
        // argument is the dialog title and the third argument is the message
        // to display.
        promptService.alert(window,"Alert",msg);
    },
    
    __logService : null, // Console logging service, used for debugging.
    get _logService() {
        if (!this.__logService)
            this.__logService = Cc["@mozilla.org/consoleservice;1"].
                                getService(Ci.nsIConsoleService);
        return this.__logService;
    },
    
    // Internal function for logging debug messages to the Error Console window
    log : function (message) {
        this._logService.logStringMessage(message);
    },
    
    // Internal function for logging error messages to the Error Console window
    error : function (message) {
        Components.utils.reportError(message);
    },
    
    removeLogins: function() {

        // Get the toolbaritem "container" that we added to our XUL markup
        var container = this._currentWindow.document.getElementById("TutTB-DynButtonContainer");

        // Remove all of the existing buttons
        for (i = container.childNodes.length; i > 0; i--) {
            container.removeChild(container.childNodes[0]);
        }
    },
    
    //TODO: update login object to support form field id info for onward passage to kfilm.fill instead of nulls
    setLogins: function(logins) {

        // Get the toolbaritem "container" that we added to our XUL markup
        var container = this._currentWindow.document.getElementById("TutTB-DynButtonContainer");

        // Remove all of the existing buttons
        for (i = container.childNodes.length; i > 0; i--) {
            container.removeChild(container.childNodes[0]);
        }

        if (logins == null || logins.length == 0)
            return;

        this.log("setting " + logins.length + " toolbar logins");

        for (var i = 0; i < logins.length; i++) {
            var login = logins[i];

            var tempButton = null;
            tempButton = this._currentWindow.document.createElement("toolbarbutton");
            tempButton.setAttribute("label", "Button " + i);
            tempButton.setAttribute("tooltiptext", "Button " + i + ": " + login.username);
            tempButton.setAttribute("oncommand", "keeFoxILM.fill('" +
                login.usernameField + "','" + login.username + "','" + login.formSubmitURL + "',null,null)");
            container.appendChild(tempButton);


        }

    },

    setupButton_installListener: {
        _KFToolBar: null,
        QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsIDOMEventListener, Components.interfaces.nsISupportsWeakReference]),

        handleEvent: function(event) {
            this.log("setupButton_installListener: got event " + event.type);

            var doc, inputElement;
            switch (event.type) {
                case "load":
                    doc = event.target;
                    this._KFToolBar.setupButton_install(doc.defaultView);
                    return;

                default:
                    this.log("This event was unexpected and has been ignored.");
                    return;
            }
        }

    },
    
    setupButton_readyListener: {
        _KFToolBar: null,
        QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsIDOMEventListener, Components.interfaces.nsISupportsWeakReference]),

        handleEvent: function(event) {
            this.log("setupButton_readyListener: got event " + event.type);

            var doc, inputElement;
            switch (event.type) {
                case "load":
                    doc = event.target;
                    this._KFToolBar.setupButton_ready(doc.defaultView);
                    return;

                default:
                    this.log("This event was unexpected and has been ignored.");
                    return;
            }
        }

    },
    
    setupButton_loadKeePassListener: {
        _KFToolBar: null,
        QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsIDOMEventListener, Components.interfaces.nsISupportsWeakReference]),

        handleEvent: function(event) {
            this.log("setupButton_loadKeePassListener: got event " + event.type);

            var doc, inputElement;
            switch (event.type) {
                case "load":
                    doc = event.target;
                    this._KFToolBar.setupButton_loadKeePass(doc.defaultView);
                    return;

                default:
                    this.log("This event was unexpected and has been ignored.");
                    return;
            }
        }

    },

    setupButton_install: function(targetWindow) {
        
        var mainWindow = targetWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIWebNavigation)
                   .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindow);

        mainButton = mainWindow.document.getElementById("KeeFox_Main-Button");
        mainButton.setAttribute("label", "Install KeeFox");
        mainButton.setAttribute("disabled", "false");
        mainButton.setAttribute("tooltiptext", "KeeFox needs to install some extra things before it can work on your computer. Click here to do that.");
        mainButton.setAttribute("oncommand", "keeFoxInst.KeeFox_MainButtonClick_install()");
    },

    setupButton_ready: function(targetWindow) {

        var mainWindow = targetWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIWebNavigation)
                   .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindow);
                   
        var DBname = mainWindow.keeFoxInst._KeeFoxXPCOMobj.getDBName();
        
        // this effectively checks that that KeeICE didn't go away while we were
        // waiting for FF to trigger the load event
        if (DBname != null)
        {
            mainButton = mainWindow.document.getElementById("KeeFox_Main-Button");
            mainButton.setAttribute("label", "KeeFox has logged you in to your '" + DBname + "' database");
            mainButton.setAttribute("disabled", "false");
            mainButton.setAttribute("tooltiptext", "KeeFox is ready to go");
            mainButton.setAttribute("oncommand", "keeFoxInst.KeeFoxMainButton_Click()");
        }
    },

    setupButton_loadKeePass: function(targetWindow) {
        
        var mainWindow = targetWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIWebNavigation)
                   .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindow);

        mainButton = mainWindow.document.getElementById("KeeFox_Main-Button");
        mainButton.setAttribute("label", "Launch KeePass");
        mainButton.setAttribute("disabled", "false");
        mainButton.setAttribute("tooltiptext", "You need to open and log into KeePass to use KeeFox. Click here to do that.");
        mainButton.setAttribute("oncommand", "keeFoxInst.KeeFoxMainButton_Click-launchKeePass()");
    },
    
    KeeFox_RunSelfTests: function(event, KFtester) {
        this._alert("Please load KeePass and create a new empty database (no sample data). Then click OK and wait for the tests to complete. Follow the test progress in the Firefox error console. WARNING: While running these tests do not load any KeePass database which contains data you want to keep.");
        try {
            KFtester._KeeFoxTestErrorOccurred = false;
            KFtester.do_tests();
        }
        catch (err) {
            this.error(err);
            this._alert("Tests failed. View the Firefox error console for further details. Summary follows:" + err);
            return;
        }

        this.log("Tests finished - everything worked!");
        this._alert("Tests finished - everything worked!");
    }


};