// Copyright 2016, EMC, Inc.

'use strict';

var di = require('di'),
    urlParse = require('url-parse');

module.exports = RedfishDiscoveryListJobFactory;
di.annotate(RedfishDiscoveryListJobFactory, new di.Provide('Job.Redfish.Discovery.List'));
di.annotate(RedfishDiscoveryListJobFactory, new di.Inject(
    'Job.Base',
    'Logger',
    'Promise',
    'Assert',
    'Util',
    'Services.Waterline',
    'Services.Encryption',
    '_',
    'JobUtils.RedfishTool'
));

function RedfishDiscoveryListJobFactory(
    BaseJob,
    Logger,
    Promise,
    assert,
    util,
    waterline,
    encryption,
    _,
    RedfishTool
) {
    var logger = Logger.initialize(RedfishDiscoveryListJobFactory);

    /**
     * @param {Object} options task options object
     * @param {Object} context graph context object
     * @param {String} taskId running task identifier
     * @constructor
     */
    function RedfishDiscoveryListJob(options, context, taskId) {
        RedfishDiscoveryListJob.super_.call(this,
                                   logger,
                                   options,
                                   context,
                                   taskId);

        this.endpointList = this.context.discoverList;
        this.redfish = new RedfishTool();
    }
    
    util.inherits(RedfishDiscoveryListJob, BaseJob);
        
    /**
     * @memberOf RedfishDiscoveryListJob
     */
    RedfishDiscoveryListJob.prototype._run = function() {
        var self = this;

        return Promise.each(self.endpointList, function(endpoint) {
            return self.discoverList(endpoint);
        })
        .then(function() {
            self._done();
        })
        .catch(function(err){
            self._done(err)
        })

    }


    RedfishDiscoveryListJob.prototype.discoverList = function(endpoint) {
        var self = this;

        assert.object(endpoint);
        assert.string(endpoint.uri);
        var parse = urlParse(endpoint.uri);
        var protocol = parse.protocol.replace(':','').trim();
        self.settings = {
            uri: parse.href,
            host: parse.host.split(':')[0],
            root: parse.pathname + '/',
            port: parse.port,
            protocol: protocol,
            username: endpoint.username,
            password: endpoint.password,
            verifySSL: false
        };
        self.redfish.settings = self.settings;
        logger.debug('set up redfish with ip ' + self.redfish.settings.host)

        return self.getRoot()
        .then(function(root) {
            return [ root, self.createChassis(root) ];
        })
        .spread(function(root, chassis) {
            return [ chassis, self.createSystems(root) ];
        })
        .spread(function(chassis, systems) {
            self.context.chassis = _.map(chassis, function(it) {
                return _.get(it, 'id');
            });
            self.context.systems = _.map(systems, function(it) {
                return _.get(it, 'id');
            });
            return Promise.all([
                self.mapPathToIdRelation(chassis, systems, 'encloses'),
                self.mapPathToIdRelation(systems, chassis, 'enclosedBy')
            ]);
        })
            .then(function(result1, result2) {
                logger.debug("all done with this node!")
            })
    };

    RedfishDiscoveryListJob.prototype.upsertRelations = function(node, relations) {
        // Update existing node with new relations or create one
        return waterline.nodes.needOne(node)
        .then(function(curNode) {
            relations = _.uniq(relations.concat(curNode.relations), 'relationType');
            return waterline.nodes.updateOne(
                { id: curNode.id }, 
                { relations: relations }
            );
        })
        .catch(function(error) {
            if (error.name === 'NotFoundError') {
                node.relations = relations;
                return waterline.nodes.create(node);
            }
            throw error;
        });
    };

    /**
     * @function getRoot
     */
    RedfishDiscoveryListJob.prototype.getRoot = function () {
        logger.debug('getting root for ip ' + this.redfish.settings.host)

        var rootPath = this.settings.root;
        return this.redfish.clientRequest()
        .then(function(response) {
            return response.body;
        });
    };
    
    /**
     * @function createChassis
     * @description initiate redfish chassis discovery
     */
    RedfishDiscoveryListJob.prototype.createChassis = function (root) {
        var self = this;
        
        if (!_.has(root, 'Chassis')) {
            throw new Error('No Chassis Members Found');
        }

        logger.debug('creating chassis for ip ' + self.redfish.settings.host)


        return self.redfish.clientRequest(root.Chassis['@odata.id'])
        .then(function(res) {
            assert.object(res);
            return res.body.Members;
        })
        .map(function(member) {
            logger.debug('creating chassis 2 for ip ' + self.redfish.settings.host)

            return self.redfish.clientRequest(member['@odata.id']);
        })
        .map(function(chassis) {
            chassis = chassis.body;
            var systems = _.get(chassis, 'Links.ComputerSystems') ||
                          _.get(chassis, 'links.ComputerSystems');
            
            if (_.isUndefined(systems)) {
                // Log a warning and skip System to Chassis relation if no links are provided.
                logger.warning('No System members for Chassis were available');
            }
            
            return {
                chassis: chassis || [],
                systems: systems || []
            };
        })
        .map(function(data) {
            assert.object(data);
            var targetList = [];
            
            _.forEach(data.systems, function(sys) {
                var target = _.get(sys, '@odata.id') ||
                             _.get(sys, 'href');
                targetList.push(target);
            });
            
            var node = {
                type: 'enclosure',
                name: data.chassis.Name,
                // todo find a better unique identifier
                //identifiers: [ data.chassis.Id ]
                identifiers: [ data.chassis.SerialNumber ]
            };
            
            var relations = [{
                relationType: 'encloses',
                targets: targetList
            }];
            
            return self.upsertRelations(node, relations)
            .then(function(n) {
                var config = Object.assign({}, self.settings);
                config.root = data.chassis['@odata.id'];

                var obm = {
                    config: config,
                    service: 'redfish-obm-service'
                };
                
                return waterline.obms.upsertByNode(n.id, obm)
                .then(function() {
                    return n;
                });
            });
        });
    };
    
    /**
     * @function createSystems
     * @description initiate redfish system discovery
     */
    RedfishDiscoveryListJob.prototype.createSystems = function (root) {
        var self = this;  
        
        if (!_.has(root, 'Systems')) {
            logger.warning('No System Members Found');
            return Promise.resolve();
        }

        logger.debug('creating system for ip ' + self.redfish.settings.host)


        return self.redfish.clientRequest(root.Systems['@odata.id'])
        .then(function(res) {
            assert.object(res);
            return res.body.Members;
        })
        .map(function(member) {

            logger.debug('creating system 2 for ip ' + self.redfish.settings.host)


            return self.redfish.clientRequest(member['@odata.id']);
        })
        .map(function(system) {
            system = system.body;
            var chassis = _.get(system, 'Links.Chassis') || 
                          _.get(system, 'links.Chassis');
            
            if (_.isUndefined(chassis)) {
                // Log a warning and skip Chassis to System relation if no links are provided.
                logger.warning('No Chassis members for Systems were available');
            }
            
            return {
                system: system || [], 
                chassis: chassis || []
            };
        })
        .map(function(data) {
            assert.object(data);
            var targetList = [];
            
            _.forEach(data.chassis, function(chassis) { 
                var target = _.get(chassis, '@odata.id') ||
                             _.get(chassis, 'href');
                targetList.push(target);
            });
            
            var identifiers = [];
            var config = Object.assign({}, self.settings);
            config.root = data.system['@odata.id'];

            logger.debug('getting root 2 for ip ' + self.redfish.settings.host)


            return self.redfish.clientRequest(config.root)
            .then(function(res) {
                var ethernet = _.get(res.body, 'EthernetInterfaces');
                if(ethernet) {
                    logger.debug('getting ethernet for ip ' + self.redfish.settings.host)

                    return self.redfish.clientRequest(ethernet['@odata.id'])
                    .then(function(res) {
                        assert.object(res, 'ethernet interfaces');
                        return res.body.Members;
                    })
                    .map(function(intf) {
                        logger.debug('getting roethernet 2 for ip ' + self.redfish.settings.host)


                        return self.redfish.clientRequest(intf['@odata.id'])
                        .then(function(port) {
                            assert.object(port, 'ethernet port');
                            if(_.has(port.body, 'MACAddress')) {
                                identifiers.push(port.body.MACAddress.toLowerCase()); 
                            };
                        }); 
                    })
                    .catch(function(err) {
                        logger.error(
                            'Error gathering ethernet information from System',
                            { error: err, root: config.root }
                        );
                        return; // don't hold up the other system resources
                    });
                }
            })
            .then(function() {
                //identifiers.push(data.system.Id);
                // todo find a better unique identifer
                identifiers.push(data.system.UUID)
                var node = {
                    type: 'compute',
                    name: data.system.Name,
                    identifiers: identifiers
                };
                
                var relations = [{
                    relationType: 'enclosedBy',
                    targets: targetList
                }];

                var obm = {
                    config: config,
                    service: 'redfish-obm-service'
                };
                
                return self.upsertRelations(node, relations)
                .then(function(nodeRecord) {
                    return Promise.all([
                        waterline.obms.upsertByNode(nodeRecord.id, obm),
                        nodeRecord
                    ]);
                })
                .spread(function(obm, node) {
                    return node;
                });
            });
        });
    };
    
    /**
     * @function mapPathToIdRelation
     * @description map source node relation types to a target
     */
    RedfishDiscoveryListJob.prototype.mapPathToIdRelation = function (src, target, type) {
        var self = this;
        src = Array.isArray(src) ? src : [ src ];
        target = Array.isArray(target) ? target : [ target ];
        return Promise.resolve(src)
        .map(function(node) {
            var ids = [];
            var deferredObms = [];
            var relations = _(node.relations).find({ 
                relationType: type
            });

            _.forEach(target, function(t) {
                deferredObms.push(waterline.obms.findByNode(t.id, 'redfish-obm-service'));
            });

            Promise.all(deferredObms)
            .then(function(obms) {
                _.forEach(target, function(t, i) {
                    _.forEach(relations.targets, function(relation) {
                        if (relation === obms[i].config.root) {
                            ids.push(t.id);
                        }
                    });
                });
                relations.targets = ids;
                relations = [ relations ];
                return self.upsertRelations({id: node.id}, relations);
            });
        }); 
    };
    
    return RedfishDiscoveryListJob;
}
