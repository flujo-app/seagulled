'use strict';

const {contextBridge, ipcRenderer} = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('seagulled:invoke', method, args);

contextBridge.exposeInMainWorld('seagulled', Object.freeze({
  state: () => invoke('state'),
  closeApp: () => invoke('closeApp'),
  chat: (text, options) => invoke('chat', text, options),
  defaultBudget: currency => invoke('defaultBudget', currency),
  planSwarm: options => invoke('planSwarm', options),
  completeSetup: payload => invoke('completeSetup', payload),
  deleteGoal: id => invoke('deleteGoal', id),
  authState: () => invoke('authState'),
  authConnect: payload => invoke('authConnect', payload),
  authCancel: () => invoke('authCancel'),
  voiceCapabilities: () => invoke('voiceCapabilities'),
  transcribeAudio: payload => invoke('transcribeAudio', payload),
  speak: text => invoke('speak', text),
  stopSpeaking: () => invoke('stopSpeaking'),
  updateGoal: (id, patch) => invoke('updateGoal', id, patch),
  controlGoal: (id, action) => invoke('controlGoal', id, action),
  controlSwarm: action => invoke('controlSwarm', action),
  readArtifact: (goalId, taskId, index) => invoke('readArtifact', goalId, taskId, index),
  discover: () => invoke('discover'),
  connect: payload => invoke('connect', payload),
  disconnect: id => invoke('disconnect', id),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Event callback required');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('seagulled:event', listener);
    return () => ipcRenderer.removeListener('seagulled:event', listener);
  }
}));
