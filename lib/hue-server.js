"use strict";
var nodeHueApi = require('node-hue-api');
var _          = require('lodash');
var LightItem  = require('./hue-light.js');


/**
 * Poll lights on the HUE bridge for changes
 * @param  {LightServer} lightServer The light server
 */
function huePoll(lightServer) {
  /**
   * Process response from Hue API
   * @param  {Error} err        Error
   * @param  {object} lightsInfo Light information
   */
  function processLights(err, lightsInfo) {
    if (err) {
      lightServer.warn(err.toString());
      return;
    }

    lightsInfo.lights.forEach((info) => {
      try {
        if (!lightServer.lights.hasOwnProperty(info.uniqueid)) {
          lightServer.addLight(info);
          return;
        }
        let light = lightServer.lights[info.uniqueid];
        light.updateInfo(info);
      }
      catch (e) {
        lightServer.warn(err.toString());
      }
    });
  }

  // Request light information
  lightServer.hueApi.lights(processLights);
}


/**
 * Server handling all lights
 * @class  LightServer
 * @param {object} config Configuration
 */
function LightServer(config) {
  var self = this;

  self.config = _.merge({}, config);

  // Ensure that we don't use to low poll interval
  if (self.config.interval !== 'number' || self.interval < 500)
    self.config.interval = 500;

  // List of all registerd nodes
  this.nodeList = {};
  this.nodeListCount = 0;

  // List of all lights
  this.lights = {};

  // Create new API
  this.hueApi = new nodeHueApi.HueApi(this.config.address, this.config.key);

  // Try to fetch lights
  self.hueApi.lights(function(err, data) {
    if (err) {
      self.error(err.toString(), err);
      return;
    }

    data.lights.forEach((item) => {
      self.addLight(item);
    });

    // Only start poll after successfully  got all lights
    self.lightPollInterval = setInterval(self.huePoll, self.config.interval);
  });

  this.lightPollInterval = null;
  this.huePoll = huePoll.bind(this, this);
}


/**
 * Stop the server
 */
LightServer.prototype.stop = function stop() {
  var self = this;
  if (this.lightPollInterval !== null)
    clearInterval(this.lightPollInterval);
  this.lightPollInterval = null;

  // Stop and remove lights
  Object.keys(this.lights).forEach((uniqueid) => {
    var light = self.lights[uniqueid];
    light.stop();
  });
  this.lights = {};
}


/**
 * Add light to the server
 * @param {object} info Hue info
 * @return {LightItem} New light
 */
LightServer.prototype.addLight = function addLight(info) {
  var self = this;
  var light = new LightItem(info);

  this.lights[light.uniqueid] = light;
  
  light.on('change', () => {
    // Calculate new color values
    let newStateColors = light.getColors();

    // Inform all subscribers
    Object.keys(self.nodeList[light.uniqueid]).forEach((nodeID) => {
      var node = self.nodeList[light.uniqueid][nodeID];
      
      light.updateNodeStatus(node);
      if (node.isOutput === true)
        node.send(newStateColors);
    });
  });

  self.statusUpdateLight(light);

  return light;
}


/**
 * Using light find all connected nodes and update state for them
 * @param  {object} light Lifx light
 */
LightServer.prototype.statusUpdateLight = function statusUpdateLight(light) {
  var self = this;

  if (this.nodeList.hasOwnProperty(light.uniqueid)) {
    let tmp = this.nodeList[light.uniqueid];
    Object.keys(tmp).forEach((nodeID) => {
      var node = self.nodeList[light.uniqueid][nodeID];
      light.updateNodeStatus(node);
      if (node.isOutput)
        node.send(light.getColors());
    });
  }
};


/**
 * Add Node-Red node to the server
 * @param {string} lightID ID/Label of the light
 * @param {string} nodeID  ID for the node
 * @param {object} node    Node-Red object
 */
LightServer.prototype.nodeRegister = function nodeRegister(lightID, nodeID, node) {
  if (!this.nodeList.hasOwnProperty(lightID))
    this.nodeList[lightID] = {};
  this.nodeList[lightID][nodeID] = node;

  // Check if we have this light already
  if (this.lights.hasOwnProperty(lightID)) {
    let light = this.lights[lightID];
    light.updateNodeStatus(node);
    if (node.isOutput)
      node.send(light.getColors());
    return;
  }

  // Light not found (yet), set status to unknown
  node.status({fill:"red",shape:"ring",text:"unknown"});
};


/**
 * Remove Node-Red node from the server
 * @param  {string} lightID ID/Label for the light
 * @param  {string} nodeID  ID for the node
 */
LightServer.prototype.nodeUnregister = function nodeUnregister(lightID, nodeID) {

  if (!this.nodeList.hasOwnProperty(lightID))
    return;

  if (!this.nodeList[lightID].hasOwnProperty(nodeID))
    return;
  
  delete this.nodeList[lightID][nodeID];
};


/**
 * Change light state
 * @param  {string} lightID ID/Label for the light
 * @param  {object} value   New values for the light
 */
LightServer.prototype.lightChange = function lightChange(lightID, value) {
  var self = this;

  if (!this.lights.hasOwnProperty(lightID))
    return;

  var light = this.lights[lightID];

  // Ensure that we don't trigger on our own update
  light.modified = process.uptime() + 1;

  // Update light information
  light.updateColor(value);

  // Build new light state
  var newState = light.getLightState();

  // Duration specified
  if (typeof value.duration === 'number' && value.duration > 0) {
    newState.transition(value.duration);
    
    // Increase modified value to include transition time
    light.modified += Math.floor(1 + (value.duration/1000));
  }

  // Update light
  this.hueApi.setLightState(light.info.id, newState, function(err) {
    if (err) {
      self.warn(err.toString());
      return;
    }
  });
}


/**
 * Retreive list of detected lights
 * @return {array} Array with id, address and label for each light
 */
LightServer.prototype.getLights = function getLights() {
  var self = this;
  var retVal = Object.keys(self.lights).reduce((coll, lightid) => {
    var light = self.lights[lightid];
    var val = { id: light.uniqueid, info: light.info.id, name: light.info.name };
    coll.push(val);
    return coll;
  }, []);

  return retVal;
 }


module.exports = function(RED) {
  // list of servers
  var hueServerList = {};

  /**
   * LightServer wrapper for Node-Red
   * @param {object} config Configuration
   */
  function LightServerWrapper(config) {
    var self = this;
    RED.nodes.createNode(self, config);

    self.name    = config.name;
    self.key     = config.key;
    self.address = config.address;
    self.interval= config.interval;

    this.lightServer = new LightServer(config);
  
    this.stop           = this.lightServer.stop.bind(this.lightServer);
    
    this.nodeRegister   = this.lightServer.nodeRegister.bind(this.lightServer);
    this.nodeUnregister = this.lightServer.nodeUnregister.bind(this.lightServer);
    
    this.lightChange    = this.lightServer.lightChange.bind(this.lightServer);

    this.getLights      = this.lightServer.getLights.bind(this.lightServer);  

    // Handle close event
    self.on('close', () => {
      self.stop();

      delete hueServerList[self.id];
    });

    hueServerList[self.id] = self;
  }

  RED.nodes.registerType("node-hue-bridge", LightServerWrapper);

  // Get list of lights
  RED.httpAdmin.get('/node-hue/lights', function(req, res) {
    if(!req.query.server) {
      res.status(500).send("Missing arguments");
      return;
    }

    // Query server for information
    if (hueServerList.hasOwnProperty(req.query.server)) {
      var server = hueServerList[req.query.server];

      res.set({'content-type': 'application/json; charset=utf-8'})
      res.end(JSON.stringify(server.getLights()));
      return;
    }

    res.status(500).send("Server not found or not activated");
    return;
  });

}
