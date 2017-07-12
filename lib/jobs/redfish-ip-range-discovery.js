// Copyright 2017, DELL EMC, Inc.

'use strict';

var di = require('di'),
    urlParse = require('url-parse');

module.exports = RedfishIpRangeDiscoveryJobFactory;
di.annotate(RedfishIpRangeDiscoveryJobFactory, new di.Provide('Job.Redfish.Ip.Range.Discovery'));
di.annotate(RedfishIpRangeDiscoveryJobFactory, new di.Inject(
    'Job.Base',
    'Logger',
    'Promise',
    'Assert',
    'Util',
    'Services.Waterline',
    'Services.Lookup',
    'Services.Configuration',
    '_',
    'HttpTool',
    'Errors',
    'JobUtils.WorkflowTool',
    'Protocol.Events',
    'validator',
    'JobUtils.RedfishTool'
));

function RedfishIpRangeDiscoveryJobFactory(
    BaseJob,
    Logger,
    Promise,
    assert,
    util,
    waterline,
    lookup,
    configuration,
    _,
    HttpTool,
    errors,
    workflowTool,
    eventsProtocol,
    validator,
    RedfishTool
) {
    var logger = Logger.initialize(RedfishIpRangeDiscoveryJobFactory);

    /**
     * @param {Object} options task options object
     * @param {Object} context graph context object
     * @param {String} taskId running task identifier
     * @constructor
     */
    function RedfishIpRangeDiscoveryJob(options, context, taskId) {
        RedfishIpRangeDiscoveryJob.super_.call(this,
            logger,
            options,
            context,
            taskId);

        assert.object(this.options);
        this.ipRangesToProcess = 0;
        this.redfishEndpoints = [];
        this.context.discoverList = [];
        this.nodeId = this.context.target;
        this.generatedRangeRequest = [];
        this.redfish = new RedfishTool();
        this.nodesToProcess = 0;

    }

    util.inherits(RedfishIpRangeDiscoveryJob, BaseJob);


    /**
     * @memberOf RedfishIpRangeDiscoveryJob
     */
    RedfishIpRangeDiscoveryJob.prototype._run = function () {
        var self = this;
        return Promise.resolve(self.discover())
            .then(function (){
                self._done()
            })
            .catch(function(err){
                self._done(err);
            });
    }

    RedfishIpRangeDiscoveryJob.prototype.discover = function() {

        var self = this;

        self.options.ranges.forEach(function(entry){
            if(!validator.isIP(entry.startIp) || !validator.isIP(entry.endIp)){
                throw new Error('Invalid IP range: (' + entry.startIp + ' - ' + entry.endIp + ')');
            }
        });

        var discoverIpList = [];
        self.options.ranges.forEach(function(range){
            if(!range.credentials || !range.credentials.userName || !range.credentials.password) {
                if(!self.options.credentials || !self.options.credentials.userName || !self.options.credentials.password) {
                    throw new Error('No credentials provided for range: (' + range.startIp + ' - ' + range.endIp + ')');
                } else {
                    range.credentials = self.options.credentials;
                }
            }
            var subIpList = self.getIpv4List(range);

            discoverIpList = discoverIpList.concat(subIpList);
        });

        // Now test every IP in the range, save valid ones to an array

        return Promise.map(discoverIpList, function (endpoint) {
            logger.debug('trying IP' + endpoint.host);
            return (self.isRedfishEndpoint(endpoint))
            .then(function(result) {
                var redfishOptions = {
                    //todo chenge to use mocked port and http vs https
                    uri: 'https://' + endpoint.host + ':443/redfish/v1',
                    username: endpoint.username,
                    password: endpoint.password
                }

                self.context.discoverList.push(redfishOptions);
                logger.debug('found');
            })
            .catch(function (e) {
                logger.debug('not found');
            })
        })
        .then(function (){
            logger.debug('done looking for nodes');
        });
    }


    RedfishIpRangeDiscoveryJob.prototype.getIpv4List = function(entry) {
        var _lastIp = entry.endIp.split(".");
        var _firstIp = entry.startIp.split(".");

        var current;
        var last;
        var ipList = [];

        for(var i=0; i<=3; i++) {
            current |= (parseInt(_firstIp[i])) << ((3-i)*8);
            last    |= (parseInt( _lastIp[i])) << ((3-i)*8);
        }

        while(current <= last){
            var ipAddr = [];
            var ipEntry = {
                host: '',
                username: '',
                password: ''
            };

            for (var i = 0; i <= 3; i++) {
                ipAddr[i] = (current >> ((3 - i) * 8)) & 0xff;
            }

            ipEntry.host = ipAddr.join('.')
            ipEntry.username = entry.credentials.userName;
            ipEntry.password = entry.credentials.password;

            ipList.push(ipEntry)

            current += 1;
            if ((current & 0xff) == 0)
            {
                // Skip IP addresses of .0
                current += 1
            }
        }

        return ipList;
    }

    RedfishIpRangeDiscoveryJob.prototype.isRedfishEndpoint = function(endpoint) {
        var self = this;
        var setups = {};
        setups.url = {};
        setups.url.protocol = 'https' //todo check to see if mock uses http or https
        setups.url.host = endpoint.host
        setups.url.port = 443;  //todo change to use mock port
        setups.url.path = '/redfish/v1';

        setups.method = 'GET';
        setups.credential = {
            username: endpoint.username || '',
            password: endpoint.password || ''
        };
        setups.verifySSl = false;
        setups.headers = {'Content-Type': 'application/json'};
        setups.recvTimeoutMs = 1800000;
        setups.data = '';

        var http = new HttpTool();

        return http.setupRequest(setups)
            .then(function(){
                return http.runRequest();
            })
            .then(function(response){
                if (response.httpStatusCode > 206) {
                    logger.error('HTTP Error', response);
                    throw new Error(response.body);
                }

                if (response.body.length > 0) {
                    response.body = JSON.parse(response.body);
                }
                return response.body;
            })
            .catch(function (error) {
                logger.debug(error)
                throw new errors.NotFoundError('Could Not find Redfish Endpoint.');
            });
    }

    return RedfishIpRangeDiscoveryJob;
}

