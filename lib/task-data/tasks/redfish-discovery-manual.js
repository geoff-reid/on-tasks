 // Copyright 2017 Dell Inc. or its subsidiaries.  All Rights Reserved.

 'use strict';

 module.exports = {
     friendlyName: "Redfish Manual Client Discovery",
     injectableName: "Task.Redfish.Discovery.Manual",
     implementsTask: "Task.Base.Redfish.Discovery.Manual",
     options: {
         uri: null,
         startIp: null,
         endIp: null
     },
     properties: {}
 };
