"use strict";

if (typeof (JSIL) === "undefined")
  throw new Error("JSIL.Core required");


JSIL.DeclareNamespace("JSIL.Replay", false);


JSIL.Replay.Initialize = function () {
  if (jsilConfig.record)
    JSIL.Replay.InitializeRecorder();
  else if (jsilConfig.replayURI)
    JSIL.Replay.InitializePlayerFromURI(jsilConfig.replayURI);
  else if (jsilConfig.replayName)
    JSIL.Replay.InitializePlayerFromLocalStorage(jsilConfig.replayName);
};

JSIL.Replay.InitializeRecorder = function () {
  var recorder = new JSIL.Replay.Recorder();

  JSIL.Host.registerService("replayRecorder", recorder);
};

JSIL.Replay.InitializePlayerFromURI = function (uri) {
  var req = new XMLHttpRequest();
  var isDone = false;

  req.open("GET", uri, false);
  req.send();

  if ((req.status >= 200) && (req.status <= 299))
    JSIL.Replay.InitializePlayerFromJSON(req.responseText);
  else
    JSIL.Host.abort(new Error("Failed to load replay from uri '" + uri + "': " + (req.statusText || req.status)));
};

JSIL.Replay.InitializePlayerFromLocalStorage = function (name) {
  var json = localStorage[name + ".replay"];

  if (json)
    JSIL.Replay.InitializePlayerFromJSON(json);
  else
    JSIL.Host.abort(new Error("Failed to load replay '" + name + "' from localStorage."));
};

JSIL.Replay.InitializePlayerFromJSON = function (json) {
  var replay = JSON.parse(json);
  var player = new JSIL.Replay.Player(replay);

  JSIL.Host.registerService("replayPlayer", player);
};

JSIL.Replay.SaveAsJSON = function () {
  var recorder = JSIL.Host.getService("replayRecorder");
  var json = JSON.stringify(recorder.replay);

  return json;
};

JSIL.Replay.SaveToLocalStorage = function (name) {
  var json = JSIL.Replay.SaveAsJSON();
  localStorage[name + ".replay"] = json;

  JSIL.Host.logWriteLine("Replay saved to local storage as '" + name + "'.");
};


// Recorder implementation

JSIL.DeclareNamespace("JSIL.Replay.Recording", false);

JSIL.Replay.Recorder = function () {
  this.replay = Object.create(null);
  this.replay.localStorage = Object.create(null);
  this.replay.frameData = Object.create(null);
  this.replay.frameCount = 0;

  this.createServiceProxies();

  this.tickScheduler = new JSIL.Replay.Recording.TickSchedulerProxy(this, JSIL.Host.getService("tickScheduler"));
  JSIL.Host.registerService("tickScheduler", this.tickScheduler);

  this.localStorage = new JSIL.Replay.Recording.LocalStorageServiceProxy(this, JSIL.Host.getService("localStorage"));
  JSIL.Host.registerService("localStorage", this.localStorage);

  for (var k in this.serviceProxies)
    this.replay.frameData[k] = [];

  this.pushFrame();
};

JSIL.Replay.Recorder.prototype.createServiceProxies = function () {
  var servicesToProxy = ["time", "keyboard", "mouse", "pageVisibility"];

  this.serviceProxies = Object.create(null);

  for (var i = 0, l = servicesToProxy.length; i < l; i++) {
    var key = servicesToProxy[i];
    var service = JSIL.Host.services[key];
    var proxy = new JSIL.Replay.Recording.ServiceProxy(service);

    this.serviceProxies[key] = proxy;
    JSIL.Host.registerService(key, proxy);
  }
};

JSIL.Replay.Recorder.prototype.pushFrame = function () {
  this.replay.frameCount += 1;

  for (var key in this.serviceProxies) {
    var callTable = Object.create(null);
    this.serviceProxies[key].calls = callTable;
    this.replay.frameData[key].push(callTable);
  }

  if (typeof (document) !== "undefined") {
    var statusSpan = document.getElementById("recordState");
    if (statusSpan)
      statusSpan.textContent = "Recording (" + this.replay.frameCount + " frame(s))";
  }
};


JSIL.Replay.Recording.ServiceProxy = function (service, transformResult) {
  this.service = service;
  this.resultTransformer = transformResult || function (methodName, result) { return result; };
  this.calls = Object.create(null);

  for (var k in service) {
    if (this.hasOwnProperty(k))
      continue;

    var value = service[k];
    if (typeof (value) === "function")
      this[k] = this.$makeInterceptor(k);
  }
};

JSIL.Replay.Recording.ServiceProxy.prototype.$pushCall = function (name, args, result, threw) {
  var list = this.calls[name];
  if (!list)
    list = this.calls[name] = [];

  list.push(this.resultTransformer(name, result));
};

JSIL.Replay.Recording.ServiceProxy.prototype.$makeInterceptor = function (name) {
  return function () {
    var args = Array.prototype.slice.call(arguments);

    var originalMethod = this.service[name];
    var failed = true;

    try {
      var result = originalMethod.apply(this.service, args);
      failed = false;

      this.$pushCall(name, args, result, false);

      return result;
    } finally {
      if (failed)
        this.$pushCall(name, args, undefined, true);
    }
  };
};


JSIL.Replay.Recording.TickSchedulerProxy = function (recorder, service) {
  this.recorder = recorder;
  this.service = service;
  this.boundFrameCallback = this.frameCallback.bind(this);
  this.pendingFrameCallback = null;
};

JSIL.Replay.Recording.TickSchedulerProxy.prototype.frameCallback = function () {
  var callback = this.pendingFrameCallback;
  this.pendingFrameCallback = null;

  this.recorder.pushFrame();
  callback();
};

JSIL.Replay.Recording.TickSchedulerProxy.prototype.schedule = function (callback, when) {
  this.pendingFrameCallback = callback;
  this.service.schedule(this.boundFrameCallback, when);
};


JSIL.Replay.Recording.LocalStorageServiceProxy = function (recorder, service) {
  this.recorder = recorder;
  this.service = service;
  this.modifiedKeys = Object.create(null);
};

JSIL.Replay.Recording.LocalStorageServiceProxy.prototype.getItem = function (key) {
  var result = this.service.getItem(key);

  var ls = this.recorder.replay.localStorage;
  if (!(key in ls) && !this.modifiedKeys[key])
    ls[key] = result;

  return result;
};

JSIL.Replay.Recording.LocalStorageServiceProxy.prototype.setItem = function (key, value) {
  this.modifiedKeys[key] = true;

  return this.service.setItem(key, value);
};

JSIL.Replay.Recording.LocalStorageServiceProxy.prototype.removeItem = function (key) {
  this.modifiedKeys[key] = true;

  return this.service.removeItem(key);
};

JSIL.Replay.Recording.LocalStorageServiceProxy.prototype.getKeys = function () {
  return this.service.getKeys();
};


// Player implementation

JSIL.DeclareNamespace("JSIL.Replay.Playback", false);

JSIL.Replay.Player = function (replay) {
  this.replay = replay;

  this.createServiceProxies();

  this.tickScheduler = new JSIL.Replay.Playback.TickSchedulerProxy(this, JSIL.Host.getService("tickScheduler"));
  JSIL.Host.registerService("tickScheduler", this.tickScheduler);

  this.localStorage = new JSIL.Replay.Playback.MockLocalStorageService(this.replay.localStorage || null);
  JSIL.Host.registerService("localStorage", this.localStorage);

  // Set the frame index to -1 so nextFrame steps us to frame 0
  this.frameIndex = -1;
  this.nextFrame();
};

JSIL.Replay.Player.prototype.createServiceProxies = function () {
  var servicesToProxy = Object.keys(this.replay.frameData);

  this.serviceProxies = Object.create(null);

  for (var i = 0, l = servicesToProxy.length; i < l; i++) {
    var key = servicesToProxy[i];
    var service = JSIL.Host.services[key];
    var proxy = new JSIL.Replay.Playback.ServiceProxy(service);

    this.serviceProxies[key] = proxy;
    JSIL.Host.registerService(key, proxy);
  }
};

JSIL.Replay.Player.prototype.setCurrentFrame = function (frameIndex) {
  this.frameIndex = frameIndex;

  this.currentFrame = Object.create(null);

  var frameData = this.replay.frameData;

  for (var key in frameData) {
    var dataForKey = frameData[key][frameIndex];
    if (typeof (dataForKey) === "undefined")
      return false;

    this.serviceProxies[key].calls = dataForKey;
  }

  return true;
};

JSIL.Replay.Player.prototype.nextFrame = function () {
  this.isPlaying = this.setCurrentFrame(this.frameIndex + 1);

  if (typeof (document) !== "undefined") {
    var statusSpan = document.getElementById("replayState");
    if (statusSpan) {
      if (this.isPlaying)
        statusSpan.textContent = "Playing (" + this.frameIndex + "/" + this.replay.frameCount + ")";
      else
        statusSpan.textContent = "Replay Ended";
    }
  }

  return this.isPlaying;
};


JSIL.Replay.Playback.ServiceProxy = function (service, transformResult) {
  this.service = service;
  this.resultTransformer = transformResult || function (methodName, result) { return result; };

  this.calls = null;

  for (var k in service) {
    if (this.hasOwnProperty(k))
      continue;

    var value = service[k];
    if (typeof (value) === "function")
      this[k] = this.$makeCallReplayer(k);
  }
};

JSIL.Replay.Playback.ServiceProxy.prototype.$makeCallReplayer = function (name) {
  return function () {
    if (this.calls === null)
      throw new Error("No call table loaded");

    var callList = this.calls[name];
    if (!callList)
      throw new Error("No call list for method '" + name + "'");
    else if (callList.length < 1)
      throw new Error("Call list for method '" + name + "' is empty");

    var result = callList.shift();

    return result;
  };
};


JSIL.Replay.Playback.TickSchedulerProxy = function (player, service) {
  this.player = player;
  this.service = service;
  this.boundAdvanceFrame = this.advanceFrame.bind(this);
  this.pendingFrameCallback = null;
};

JSIL.Replay.Playback.TickSchedulerProxy.prototype.advanceFrame = function () {
  var callback = this.pendingFrameCallback;
  this.pendingFrameCallback = null;

  if (this.player.nextFrame())
    callback();
  else {
    JSIL.Host.logWriteLine("Replay ended after " + this.player.frameIndex + " frame(s).");

    try {
      Microsoft.Xna.Framework.Game.ForcePause();
    } catch (exc) {
    }
  }
};

JSIL.Replay.Playback.TickSchedulerProxy.prototype.schedule = function (callback, when) {
  this.pendingFrameCallback = callback;

  var fastPlayback = jsilConfig.fastReplay || false;
  if (typeof (document) !== "undefined") {
    var checkbox = document.getElementById("fastReplay")
    if (checkbox)
      fastPlayback = Boolean(checkbox.checked);
  }

  if (fastPlayback)
    window.setTimeout(this.boundAdvanceFrame, 0);
  else
    this.service.schedule(this.boundAdvanceFrame, when);
};


JSIL.Replay.Playback.MockLocalStorageService = function (initialData) {
  this.data = Object.create(initialData);
};

JSIL.Replay.Playback.MockLocalStorageService.prototype.getItem = function (key) {
  if (key in this.data)
    return this.data[key];
  else
    return null;
};

JSIL.Replay.Playback.MockLocalStorageService.prototype.setItem = function (key, value) {
  return this.data[key] = value;
};

JSIL.Replay.Playback.MockLocalStorageService.prototype.removeItem = function (key) {
  delete this.data[key];
};

JSIL.Replay.Playback.MockLocalStorageService.prototype.getKeys = function () {
  return Object.keys(this.data);
};


JSIL.Host.initCallbacks.push(JSIL.Replay.Initialize);