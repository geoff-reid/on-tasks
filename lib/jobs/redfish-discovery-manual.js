// Copyright 2017 Dell Inc. or its subsidiaries.  All Rights Reserved.

'use strict';

var di = require('di'),
    urlParse = require('url-parse');

module.exports = RedfishDiscoveryJobFactory;
di.annotate(RedfishDiscoveryJobFactory, new di.Provide('Job.Redfish.Discovery.Manual'));
di.annotate(RedfishDiscoveryJobFactory, new di.Inject(
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

function RedfishDiscoveryJobFactory(
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
    var logger = Logger.initialize(RedfishDiscoveryJobFactory);

    /**
     * @param {Object} options task options object
     * @param {Object} context graph context object
     * @param {String} taskId running task identifier
     * @constructor
     */
    function RedfishDiscoveryJob(options, context, taskId) {
        RedfishDiscoveryJob.super_.call(this,
            logger,
            options,
            context,
            taskId);

        console.log("********************DRB in _RedfishDiscoveryJob");
        assert.object(this.options);
        assert.string(this.options.uri);
        var parse = urlParse(this.options.uri);
        var protocol = parse.protocol.replace(':','').trim();
        this.settings = {
            uri: parse.href,
            host: parse.host.split(':')[0],
            root: parse.pathname + '/',
            port: parse.port,
            protocol: protocol,
            username: this.options.username,
            password: this.options.password,
            verifySSL: this.options.verifySSL || false
        };
        this.redfish = new RedfishTool();
        this.redfish.settings = this.settings;
    }

    util.inherits(RedfishDiscoveryJob, BaseJob);

    /**
     * @memberOf RedfishDiscoveryJob
     */
    RedfishDiscoveryJob.prototype._run = function() {
        var self = this;
        console.log("********************DRB in _run");

        return self.getRoot()
            .then(function(root) {

                // TODO Put more code here...

            })
            .then(function() {
                self._done();
            })
            .catch(function(err) {
                self._done(err);
            });
    };

    RedfishDiscoveryJob.prototype.upsertRelations = function(node, relations) {
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
    RedfishDiscoveryJob.prototype.getRoot = function () {
        var rootPath = this.settings.root;
        return this.redfish.clientRequest(rootPath)
            .then(function(response) {
                return response.body;
            });
    };


    /**
     * @function createSystems
     * @description initiate redfish system discovery
     */
    RedfishDiscoveryJob.prototype.createSystems = function (root) {
        var self = this;

        if (!_.has(root, 'Systems')) {
            logger.warning('No System Members Found');
            return Promise.resolve();
        }

        return self.redfish.clientRequest(root.Systems['@odata.id'])
            .then(function(res) {
                assert.object(res);
                return res.body.Members;
            })
            .map(function(member) {
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

                return self.redfish.clientRequest(config.root)
                    .then(function(res) {
                        var ethernet = _.get(res.body, 'EthernetInterfaces');
                        if(ethernet) {
                            return self.redfish.clientRequest(ethernet['@odata.id'])
                                .then(function(res) {
                                    assert.object(res, 'ethernet interfaces');
                                    return res.body.Members;
                                })
                                .map(function(intf) {
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
                        identifiers.push(data.system.Id);
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
    RedfishDiscoveryJob.prototype.mapPathToIdRelation = function (src, target, type) {
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

    return RedfishDiscoveryJob;
}
