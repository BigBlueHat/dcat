var crypto = require('crypto')
  , colors = require('colors')
  , url = require('url')
  , _ = require('underscore')
  , isUrl = require('is-url')
  , semver = require('semver')
  , glob = require('glob')
  , minimatch = require('minimatch')
  , querystring = require('querystring')
  , cookie = require('cookie')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , request = require('request')
  , path = require('path')
  , mime = require('mime')
  , rimraf = require('rimraf')
  , mkdirp = require('mkdirp')
  , async = require('async')
  , fs = require('fs')
  , stream = require('stream')
  , zlib = require('zlib')
  , tar = require('tar-stream')
  , once = require('once')
  , concat = require('concat-stream')
  , jsonld = require('jsonld')
  , clone = require('clone')
  , githubUrlToObject = require('github-url-to-object')
  , bitbucketUrlToObject = require('bitbucket-url-to-object')
  , SchemaOrgIo = require('schema-org-io')
  , os = require('os');

request = request.defaults({json:true, strictSSL: false});

var conf = require('rc')('dcat', {protocol: 'https:', port: 443, hostname: 'dcat.io', strictSSL: false});

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj'],
  'application/x-gzip': ['gz', 'gzip'],
  'application/x-gtar':['tgz'], //tar.gz won't work
  'text/x-clojure': ['clj'],
  'text/x-coffeescript': ['coffee'],
  'text/x-go': ['go'],
  'text/x-ocaml': ['ocaml', 'ml', 'mli'],
  'text/x-scala': ['scala'],
  'text/x-python': ['py'],
  'text/x-r': ['r'],
  'text/x-rust': ['rs'],
  'text/x-matlab': ['m'],
  'text/x-erlang': ['erl'],
  'text/x-julia': ['jl'],
  'text/x-perl': ['pl'],
  'text/x-java': ['java']
});

var Dcat = module.exports = function(rc, root, packager){
  EventEmitter.call(this);

  this.root = root || process.cwd();
  this.rc = rc || conf;

  this.packager = packager || new SchemaOrgIo();
};

util.inherits(Dcat, EventEmitter);

Dcat.type = function(mimetype){
  if (!mimetype || mimetype === 'application/octet-stream') return;

  mimetype = mimetype.split(';')[0].trim();

  if (mimetype.split('/')[0] === 'image' || ~['application/postscript', 'application/vnd.ms-powerpoint'].indexOf(mimetype) ) {
    return 'ImageObject';
  } else if (mimetype.split('/')[0] === 'video') {
    return 'VideoObject';
  } else if (mimetype.split('/')[0] === 'audio') {
    return 'AudioObject';
  } else if (~['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/tab-separated-values', 'application/json', 'application/ld+json', 'application/x-ldjson', 'application/xml', 'application/rdf+xml', 'text/n3', 'text/turtle'].indexOf(mimetype)) {
    return 'Dataset';
  } else if (~['application/javascript', 'application/ecmascript', 'text/x-asm', 'text/x-c', 'text/x-fortran', 'text/x-java', 'text/x-java-source', 'text/x-pascal', 'text/x-clojure', 'text/x-coffeescript', 'text/x-go', 'text/x-ocaml', 'text/x-scala', 'text/x-python', 'text/x-r', 'text/x-rust', 'text/x-erlang', 'text/x-julia', 'text/x-perl'].indexOf(mimetype)) {
    return 'Code';
  } else if (~['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text', 'application/x-latex'].indexOf(mimetype)) {
    return 'Article';
  } else if (~['text/html', 'application/xhtml+xml'].indexOf(mimetype)) {
    return 'WebPage';
  } else if (mimetype === 'text/x-markdown') {
    return 'Readme';
  }
};


Dcat.prototype._auth = function(){
  return {user: this.rc.name, pass: this.rc.password};
};

Dcat.prototype.url = function(pathnameOrCurie){
  if (isUrl(pathnameOrCurie)) {
    return pathnameOrCurie;
  }

  var protocol, hostname, port, pathname;
  var splt = pathnameOrCurie.split(':');

  if (splt.length === 2) { // CURIE
    var ctx = SchemaOrgIo.context()['@context'][1];
    if (splt[0] in ctx) {
      if (splt[0] === 'ldr') {
        protocol = this.rc.protocol;
        hostname = this.rc.hostname;
        port = this.rc.port;
      } else {
        var purl = url.parse(ctx[splt[0]]);
        protocol = purl.protocol;
        hostname = purl.hostname;
        port = purl.port;
      }
      pathname = splt[1];
    } else {
      throw new Error('unsupported CURIE prefix: ' + splt[0]);
    }
  } else { //<-pathname
    protocol = this.rc.protocol;
    hostname = this.rc.hostname;
    port = this.rc.port;
    pathname = pathnameOrCurie;
  }

  return protocol + '//'  + hostname + ((port && (port !== 80 && port !== 443)) ? (':' + port) : '') + '/' + pathname.replace(/^\/|\/$/g, '');
};

Dcat.prototype.namespace = function(curie){
  var purl = url.parse(this.url(curie));
  if ((purl.hostname === url.parse(SchemaOrgIo.contextUrl).hostname) || (purl.hostname === this.rc.hostname)) {
    return purl.pathname.replace(/^\/|\/$/g, '').split('/')[0];
  }
}

Dcat.prototype._error = function(msg, code){
  if (typeof msg === 'object') {
    msg = msg.description || msg.reason || msg.error || 'error';
  }

  var err = new Error(msg);
  if (code !== undefined) { err.code = code; }
  return err;
};

Dcat.prototype.log = function(verbOrstatusCode, pathnameOrUrl, protocol){
  var uri = this.url(pathnameOrUrl);
  protocol = protocol || url.parse(uri).protocol;

  this.emit('log', 'dcat'.grey + ' ' + protocol.split(':')[0].green + ' ' + verbOrstatusCode.toString().magenta + ' ' + uri.replace(/:80\/|:443\//, '/'));
};

Dcat.prototype.addUser = function(callback){
  //chech that we need to add a user
  request.get({url: this.url('session'), auth: this._auth()}, function(err, respCheck, body){
    if (err) return callback(err);

    if (respCheck.statusCode === 200) {
      return callback(null, body);
    }

    //From here: auth failed: invalid name or password or user does not exists we try to create it
    var userdata = {
      '@context': SchemaOrgIo.contextUrl,
      '@id': 'ldr:users/' + this.rc.name,
      '@type': ['Person', 'Role'],
      email: 'mailto:' + this.rc.email,
      password: this.rc.password
    };

    var rurl = this.url('users/' + this.rc.name);
    this.log('PUT', rurl);
    request.put({url: rurl, json: userdata, auth: this._auth()}, function(err, resp, body){
      if (err) return callback(err);
      this.log(resp.statusCode, rurl);
      if (resp.statusCode < 400) {
        callback(null, body);
      } else if (resp.statusCode === 409) {
        if (respCheck.statusCode === 401) {
          err = this._error('invalid password for user: ' + this.rc.name, respCheck.statusCode);
        } else {
          err = this._error('username ' + this.rc.name + ' already exists', resp.statusCode);
        }
        callback(err, body);
      } else {
        err = this._error(body, resp.statusCode);
        callback(err, body);
      }
    }.bind(this));

  }.bind(this));

};

Dcat.prototype.wrap = function(tGlobsOrTurls, opts, callback){
  if (arguments.length === 2) {
    callback = opts;
    opts = {};
  } else {
    opts = clone(opts);
  }

  var myTglobsOrTurls = Array.isArray(tGlobsOrTurls) ? tGlobsOrTurls : [tGlobsOrTurls];

  function _isUrl(tGlobsOrTurl) {
    var x = (typeof tGlobsOrTurl === 'string') ? tGlobsOrTurl : tGlobsOrTurl.id;

    return isUrl(x) || githubUrlToObject(x) || bitbucketUrlToObject(x);
  };

  this._pathToResource(myTglobsOrTurls.filter(function(x){return !_isUrl(x);}), opts , function(err, resourcesFromPath, reservedIds){
    if (err) return callback(err);
    opts.reservedIds = reservedIds;
    this._urlToResource(myTglobsOrTurls.filter(function(x){return _isUrl(x);}), opts, function(err, resourcesFromUrls, reservedIds){
      if (err) return callback(err);
      callback(null, (resourcesFromPath || []).concat(resourcesFromUrls || []), reservedIds);
    });
  }.bind(this));

};

Dcat.prototype._pathToResource = function(globs, opts, callback){
  if (arguments.length === 2) {
    callback = opts;
    opts = {};
  }

  var reservedIds = opts.reservedIds || {}; //make sure @ids are unique

  var globList = Array.isArray(globs) ? globs : [globs];

  globList = globList.map(function(x){
    return (typeof x === 'string') ? {id: x} : x; //a `type` can be specified in addition to `id` (`id` is a glob or file path)
  });

  async.map(globList, function(tglob, cb){
    glob(path.resolve(this.root, tglob.id), {matchBase: true, mark:true}, function(err, absPaths){
      if (err) return cb(err);

      absPaths = absPaths.filter(minimatch.filter('!**/JSONLD', {matchBase: true}));
      //apply custom filter function (if any)
      absPaths = (opts.fFilter) ? absPaths.filter(opts.fFilter) : absPaths;


      //exclude all directories path of directories containing files (if a directory does not contain file => glob was matching the directory and we want to keep it)

      //get the directory paths
      var isDir = /\/$/;
      var dirAbsPaths = absPaths.filter(function(p){
        return isDir.test(p);
      });

      var dirToExclude = [];
      dirAbsPaths.forEach(function(d){
        var re = new RegExp('^'+ d.replace('/', '\/'));
        var match = absPaths.filter(function(p){return re.test(p)});
        if (match.length > 1) {
          dirToExclude.push(d);
        }
      });
      absPaths = _.difference(absPaths, dirToExclude);

      return cb(null, absPaths.map(function(p){ return {absPath: p, type: tglob.type};}));
    });
  }.bind(this), function(err, tabsPaths){
    if (err) return cb(err);

    tabsPaths = _.flatten(tabsPaths);
    var utabsPaths = _.uniq(tabsPaths, function(x){return x.absPath;});
    if (utabsPaths.length !== tabsPaths.length) {
      return callback(new Error('duplicate paths'));
    }

    //transform abs paths to resources and make source each resource has a unique @id
    function _getStatsAndParts (tp, cb){
      fs.stat(tp.absPath, function(err, stats){
        if (err) return cb(err);
        if (stats.isDirectory) {
          glob(path.join(tp.absPath, '**/*'), function(err, dirAbsPaths){
            if (err) return cb(err);
            async.map(dirAbsPaths, fs.stat, function(err, dirAbsPathStats){
              if (err) return cb(err);
              var parts = dirAbsPathStats
                .map(function(x, i){ return {stats: x, absPath: dirAbsPaths[i]}; })
                .filter(function(x){ return x.stats.isFile(); });
              cb(null, stats, parts);
            });
          });
        } else {
          return cb(null, stats);
        }
      });
    };

    async.map(utabsPaths, function(tp, cb){
      _getStatsAndParts(tp, function(err, stats, dirAbsPaths){
        if (err) return cb(err);

        var ext, mymime;
        if (/\.tar\.gz$/.test(tp.absPath)) {
          ext = '.tar.gz';
          mymime = 'application/x-gtar';
        } else {
          ext = path.extname(tp.absPath); //if directory -> ''
          mymime = mime.lookup(ext); //if '' -> 'application/octet-stream'
        }

        var prefix = (opts.namespace)? (opts.namespace + '/') : '';
        var mypath = path.relative(this.root, tp.absPath)
          , myid = prefix + (path.basename(tp.absPath, ext).trim().replace(/ /g, '-').toLowerCase() || 'p') ;

        var hasPart;
        if (stats.isDirectory()) {
          hasPart = dirAbsPaths.map(function(x){
            return { '@type': 'MediaObject', 'filePath': path.relative(this.root, x.absPath), 'contentSize': x.stats.size, 'dateModified': x.stats.mtime };
          }, this);
        }

        //try to patch MIME
        if (stats.isFile() && mymime == 'application/octet-stream') {
          if (~['readme', 'license'].indexOf(path.basename(tp.absPath).trim().toLowerCase())) {
            mymime = 'text/plain';
          }
        }

        var uid = myid, i = 1;
        while (uid in reservedIds) { uid = myid + '-' + i++; }
        reservedIds[uid] = true;

        var r = {
          '@id': uid,
          '@type': tp.type || Dcat.type(mymime) || 'CreativeWork'
        };

        if (this.packager.isClassOrSubClassOf(r['@type'], 'SoftwareApplication')) { //special case

          if (stats.isDirectory()) {
            return cb(new Error('directories are not supported for SoftwareApplication or subclasses of SoftwareApplication'));
          }
          r.fileFormat = mymime;
          r.filePath = mypath;
          r.fileSize = stats.size;
          r.dateModified = stats.mtime.toISOString();
          r.operatingSystem = os.type() + ' ' + os.release();
          r.processorRequirements = os.arch();

        } else {

          var encoding = { dateModified: stats.mtime.toISOString() };

          if (stats.isDirectory()) {
            encoding.encodingFormat = 'application/x-gtar'; //.tar.gz according to http://en.wikipedia.org/wiki/List_of_archive_formats
            encoding.hasPart = hasPart;
          } else {
            encoding.encodingFormat = mymime;
            encoding.filePath = mypath;
            encoding.contentSize = stats.size;
          }

          if (this.packager.isClassOrSubClassOf(r['@type'], 'Dataset')) {
            //TODO about
            r.distribution = _.extend({'@type': 'DataDownload'}, encoding);
          } else if (this.packager.isClassOrSubClassOf(r['@type'], 'Code')) {
            //try to guess programming language
            if (stats.isDirectory()) {
              var langs = [];
              for (var i=0; i<hasPart.length; i++) {
                var p = hasPart[i].filePath;
                var m;
                if (/\.tar\.gz$/.test(p)) {
                  m = 'application/x-gtar';
                } else {
                  m = mime.lookup(p);
                }

                var m2 = m.split('/')[1];
                if (Dcat.type(m) === 'Code') {
                  langs.push(m2.split('-')[1] || m2);
                }
              }
              if (langs.length){
                langs = _.uniq(langs).map(function(lang){return {name: lang};});
                r.programmingLanguage = (langs.length === 1) ? langs[0]: langs;
              }
            } else {
              var m2 = mymime.split('/')[1];
              if (Dcat.type(mymime) === 'Code') {
                r.programmingLanguage = { name: m2.split('-')[1] || m2 };
              }
            }
            r.encoding = _.extend({'@type': 'MediaObject'}, encoding);
          } else {
            r.encoding = _.extend({'@type': 'MediaObject'}, encoding);
          }
        }
        cb(null, r);
      }.bind(this));
    }.bind(this), function(err, resources){
      callback(err, resources, reservedIds);
    });
  }.bind(this));

};


Dcat.prototype._urlToResource = function(turls, opts, callback){
  if (arguments.length === 2) {
    callback = opts;
    opts = {};
  } else {
    opts = clone(opts);
  }

  var reservedIds = opts.reservedIds || {}; //make sure @ids are unique

  var turi = Array.isArray(turls) ? turls : [turls];
  turi = turi.map(function(x){
    return (typeof x === 'string') ? {id: x} : x; //a `type` can be specified (id is an URL)
  });

  var uturi = _.uniq(turi, function(x){return x.id;});
  if (uturi.length !== turi.length) {
    return callback(new Error('duplicated URLs'));
  }

  async.map(uturi, function(myturi, cb){

    var repo = githubUrlToObject(myturi.id) || bitbucketUrlToObject(myturi.id);
    if (repo) {
      var myid = repo.repo;
      var uid = myid, i = 1;
      while (uid in reservedIds) { uid = myid + '-' + i++; }
      reservedIds[uid] = true;

      var r =  {
        '@id': myid,
        '@type': myturi.type || 'Code',
      };

      if (!this.packager.isClassOrSubClassOf(r['@type'], 'Code')) {
        return cb(new Error('URL of code repositories must be of @type Code (or a subclass of Code)'));
      }

      r.codeRepository = repo.https_url;

      this.log('HEAD', repo.tarball_url);
      //see https://developer.github.com/v3/#user-agent-required
      request.head({url:repo.tarball_url, followAllRedirects:true, headers: {'User-Agent': 'dcat'}}, function(err, resp){
        if (err) return cb(err);
        this.log(resp.statusCode, repo.tarball_url);
        if (resp.statusCode >= 400) {
          return cb(this._error('could not HEAD ' + repo.tarball_url), resp.statusCode);
        }

        r.encoding = {
          '@type': 'MediaObject',
          contentUrl: repo.tarball_url,
          encodingFormat: resp.headers['content-type']
        };
        if ('content-length' in resp.headers) {
          r.encoding.contentSize = parseInt(resp.headers['content-length'], 10);
        }
        if ('last-modified' in resp.headers) {
          r.encoding.dateModified = (new Date(resp.headers['last-modified'])).toISOString();
        }
        return cb(null, r);

      }.bind(this));
    } else {

      this.log('HEAD', myturi.id);
      request.head({url: myturi.id, followAllRedirects:true}, function(err, resp){
        if (err) return cb(err);
        this.log(resp.statusCode, myturi.id);
        if (resp.statusCode >= 400) {
          return cb(this._error('could not HEAD ' + myturi.id), resp.statusCode);
        }

        var prefix = (opts.namespace)? (opts.namespace + '/') : '';
        var mymime = resp.headers['content-type']
          , mypath = url.parse(myturi.id).pathname
          , myid = prefix + (path.basename(mypath, path.extname(mypath)).trim().replace(/ /g, '-').toLowerCase() || 'p');

        var uid = myid, i = 1;
        while (uid in reservedIds) { uid = myid + '-' + i++; }
        reservedIds[uid] = true;

        var r = { '@id': uid, '@type': myturi.type || Dcat.type(mymime) || 'CreativeWork' };

        var contentSize;
        if ('content-length' in resp.headers) {
          contentSize = parseInt(resp.headers['content-length'], 10);
        }

        if (this.packager.isClassOrSubClassOf(r['@type'], 'SoftwareApplication')) {
          r.downloadUrl = myturi.id;
          r.fileFormat = resp.headers['content-type'];
          if ('last-modified' in resp.headers) {
            r.dateModified = (new Date(resp.headers['last-modified'])).toISOString();
          }
          if (!('content-encoding' in resp.headers) && (contentSize !== undefined)) {
            r.fileSize = contentSize;
          }
        } else {
          var encoding = {
            contentUrl: myturi.id,
            encodingFormat: mymime
          };
          if ('last-modified' in resp.headers) {
            encoding.dateModified = (new Date(resp.headers['last-modified'])).toISOString();
          }
          if ('content-encoding' in resp.headers) {
            encoding.encoding = { '@type': 'MediaObject',  encodingFormat: resp.headers['content-encoding'] };
            if ( contentSize !== undefined ) {
              encoding.encoding.contentSize = contentSize;
            }
          } else if (contentSize !== undefined) {
            encoding.contentSize = contentSize;
          }

          if (this.packager.isClassOrSubClassOf(r['@type'], 'Dataset')) {
            r.distribution = _.extend({'@type': 'DataDownload'}, encoding);
          } else if (this.packager.isClassOrSubClassOf(r['@type'], 'Code')) {
            r.encoding = _.extend({'@type': 'MediaObject'}, encoding);
            //try to get programming language for MIME
            var inferedType = Dcat.type(mymine);
            if (inferedType === 'Code') {
              var m2 = mymime.split('/')[1];
              r.programmingLanguage = { name: m2.split('-')[1] || m2 };
            }
          } else {
            r.encoding = _.extend({'@type': 'MediaObject'}, encoding);
          }
        }
        cb(null, r);

      }.bind(this));

    }

  }.bind(this), function(err, resources){
    callback(err, resources, reservedIds);
  });
};

Dcat.prototype.add = function(doc, tGlobsOrTurls, opts, callback){

  if (arguments.length === 3) {
    callback = opts;
    opts = {};
  } else {
    opts = clone(opts);
  }

  //flatten the doc to get all the @id and generate opts.reservedIds
  var tdoc = clone(doc);
  var ctx;
  if (tdoc['@context'] === SchemaOrgIo.contextUrl) {
    tdoc['@context'] = SchemaOrgIo.context()['@context']; //offline
    ctx = tdoc['@context'];
  }

  jsonld.flatten(tdoc, ctx || tdoc['@context'], function(err, fdoc){
    if (err) return callback(err);

    var ioIds = fdoc['@graph']
      .filter(function(x){
        return x['@id'] && x['@id'].split(':')[0] === 'ldr';
      })
      .map(function(x){
        return x['@id'].split(':')[1]
      });

    opts.reservedIds = opts.reservedIds || {};
    ioIds.forEach(function(id){ opts.reservedIds[id] = true; });

    //get namespace
    if (doc['@id']) {
      opts.namespace = opts.namespace || this.namespace(doc['@id']);
    }

    this.wrap(tGlobsOrTurls, opts, function(err, parts){
      if (err) return callback(err);

      if (!doc.hasPart) {
        doc.hasPart = [];
      } else {
        doc.hasPart = Array.isArray(doc.hasPart) ? doc.hasPart : [doc.hasPart];
      }

      doc.hasPart = doc.hasPart.concat(parts);
      callback(null, doc, opts.reservedIds);

    }.bind(this));
  }.bind(this));

};


/**
 * if no doc is provided, will be read from JSONLD
 * resolve all the CURIES and take into account any potential nested @context
 */
Dcat.prototype.cdoc = function(doc, callback){
  if (arguments.length === 1) {
    callback = doc;
    doc = undefined;
  }

  var ctxUrl = this.url('');
  function _next(doc){
    var ctx;
    if (doc['@context'] === SchemaOrgIo.contextUrl) {//help for testing
      ctx = doc['@context'];
      doc['@context'] = ctxUrl;
    }

    jsonld.compact(doc, ctxUrl, function(err, cdoc){
      if (err) return callback(err);

      if (ctx && cdoc['@context'] === ctxUrl) {
        cdoc['@context'] = ctx;
      }

      callback(null, cdoc);
    });
  };

  if (doc) {
    _next(doc);
  } else {
    fs.readFile(path.resolve(this.root, 'JSONLD'), function(err, doc){
      if (err) return callback(err);
      try {
        doc = JSON.parse(doc);
      } catch (e) {
        return callback(e);
      }
      _next(doc);
    });
  }

};

Dcat.prototype.publish = function(doc, opts, callback){

  if (arguments.length === 1) {
    callback = doc;
    doc = undefined;
    opts = {};
  } else if (arguments.length === 2) {
    callback = opts;
    opts = {};
  }


  this.cdoc(doc, function(err, cdoc){
    try {
      this.packager.validate(cdoc);
    } catch (e) {
      return callback(e);
    }

    //get a list of nodes to process (computes checksums, sizes... and upload to s3)
    async.each(this._mnodes(cdoc), function(mnode, cb){
      if (mnode.node.filePath || (mnode.node.hasPart && mnode.node.hasPart.some(function(x){return x.filePath;}))) {
        this._archiveFile(mnode, cb);
      } else if (mnode.node.contentUrl || mnode.node.downloadUrl) {
        this._archiveUrl(mnode, cb);
      } else {
        cb(null);
      }
    }.bind(this), function(err){
      if (err) return callback(err);
      //publish cdoc on the registry (now that mnode has been updated/mutated)
      var rurl = this.url(cdoc['@id']);
      this.log('PUT', rurl);
      request.put({url:rurl, json: cdoc, auth: this._auth()}, function(err, resp, body){
        if (err) return callback(err);
        this.log(resp.statusCode, rurl);

        if (resp.statusCode === 409) {
          callback(this._error((cdoc['@id'] + (('version' in cdoc) ? ('@' + cdoc.version) : '') + ' has already been published'), resp.statusCode));
        } else if (resp.statusCode >= 400) {
          callback(this._error(body, resp.statusCode), resp.statusCode);
        } else {
          callback(null, cdoc, resp.statusCode);
        }

      }.bind(this));
    }.bind(this));

  }.bind(this));

};


Dcat.prototype._mnodes = function(cdoc){
  var mnodes = [];
  var mprops = ['filePath', 'contentUrl', 'downloadUrl'];

  var packager = this.packager;

  function _isMnode(node, prop){
    if (_.intersection(Object.keys(node), mprops).length) {
      return true;
    }

    if (prop === 'encoding' && node.hasPart) {
      var parts = Array.isArray(node.hasPart)? node.hasPart : [node.hasPart];
      for (var i=0; i<parts.length; i++) {
        var part = parts[i];
        if (part.filePath) {
          return true;
        }
      }
    }

    return false;
  };

  if (_isMnode(cdoc)) { mnodes.push({node: cdoc, type: packager.getType(cdoc)}); }
  (function _forEachNode(cdoc){
    for (var prop in cdoc) {
      if (prop === '@context' || !cdoc.hasOwnProperty(prop)) continue;

      if (Array.isArray(cdoc[prop])) {
        for (var i=0; i<cdoc[prop].length; i++) {
          if (typeof cdoc[prop][i] === 'object') {
            if (_isMnode(cdoc[prop][i], prop)) {
              mnodes.push({node: cdoc[prop][i], type: packager.getType(cdoc[prop][i], packager.getRanges(prop))});
            } else {
              _forEachNode(cdoc[prop][i]);
            }
          }
        }
      } else if (typeof cdoc[prop] === 'object') {
        if (_isMnode(cdoc[prop], prop)) {
          mnodes.push({node: cdoc[prop], type: packager.getType(cdoc[prop], packager.getRanges(prop))});
        } else {
          _forEachNode(cdoc[prop]);
        }
      }
    }
  })(cdoc);

  return mnodes;
};


Dcat.prototype._archiveFile = function(mnode, callback){
  var root = this.root;

  var isSoftwareApplication = this.packager.isClassOrSubClassOf(mnode.type, 'SoftwareApplication');
  var isMediaObject = this.packager.isClassOrSubClassOf(mnode.type, 'MediaObject');

  var psize, pformat;
  if (isSoftwareApplication) {
    psize = 'fileSize';
    pformat = 'fileFormat';
  } else if (isMediaObject) {
    psize = 'contentSize';
    pformat = 'encodingFormat';
  }

  var packager = this.packager;

  //check that all the files are here and update dateModified and contentSize
  function _check(mnode, cb){
    if (mnode.node.filePath) {
      fs.stat(path.resolve(root, mnode.node.filePath), function(err, stats){
        if (err) return cb(err);
        mnode.node.dateModified = stats.mtime.toISOString();
        if (psize) { mnode.node[psize] = stats.size; }
        cb(null);
      });
    } else if (mnode.node.hasPart) {
      var hasPart = (Array.isArray(mnode.node.hasPart)) ? mnode.node.hasPart : [mnode.node.hasPart];
      async.each(hasPart, function(part, cb2){
        if (part.filePath) {
          fs.stat(path.resolve(root, part.filePath), function(err, stats){
            if (err) return cb2(err);
            part.dateModified = stats.mtime.toISOString();

            var type = packager.getType(part, packager.getRanges('hasPart'));
            var isSoftwareApplication = type && packager.isClassOrSubClassOf(type, 'SoftwareApplication');
            var isMediaObject = type && packager.isClassOrSubClassOf(type, 'MediaObject');

            if (isSoftwareApplication) {
              part.fileSize = stats.size;
            } else if (isMediaObject) {
              part.contentSize = stats.size;
            }

            cb2(null);
          });
        } else {
          cb2(null);
        }
      }, cb);
    } else {
      cb(null);
    }
  };

  _check(mnode, function(err){
    if (err) return this._checkMnodeUrl(mnode, callback);

    var mstream = this._mstream(mnode);
    this.checksum(mstream, function(err, checksum, size, sha1Hex, md5Base64){
      if (err) return callback(err);

      var contentType = mnode.node.encodingFormat || mnode.node.fileFormat;
      if (!contentType) {
        if ( mstream.isTarGz || (/\.tar\.gz$/.test(mnode.node.filePath)) ) {
          contentType = 'application/x-gtar';
        } else {
          contentType = mime.lookup(mnode.node.filePath || '');
        }

        if (pformat) {
          mnode.node[pformat] = contentType;
        }
      }

      if (isMediaObject && mstream.isContentEncodingGzip) {
        mnode.node.encoding = mnode.encoding || {};
        mnode.node.encoding.contentSize = size;
        mnode.node.encoding.hasChecksum = checksum;
        mnode.node.encoding.encodingFormat = 'gzip';
      } else {
        if (mstream.isTarGz && psize) {
          mnode.node[psize] = size;
        }
        mnode.node.hasChecksum = checksum;
      }

      var headers = {
        'Content-Length': size,
        'Content-Type': contentType,
        'Content-MD5': md5Base64
      };
      if (mstream.isContentEncodingGzip) {
        headers['Content-Encoding'] =  'gzip';
      }

      //PUT resource on S3 via dcat.io registry (the registry will check if it exists already)
      var rurl = this.url('r/' + sha1Hex);
      this.log('PUT', rurl);
      var r = request.put({url: rurl, headers: headers, json:true, auth: this._auth()}, function(err, resp, body){
        if (err) return callback(err);
        this.log(resp.statusCode, rurl);
        if (resp.statusCode >= 400) {
          return callback(this._error(body, resp.statusCode));
        }

        //TODO if not isSoftwareApplication and not isMediaObject what to do??? right now we use contentUrl but meh.
        mnode.node[(isSoftwareApplication)? 'downloadUrl' : 'contentUrl'] = 'r/' + sha1Hex;
        if (isMediaObject) {
          mnode.node.uploadDate = (new Date()).toISOString();
        }

        callback(null);
      }.bind(this));
      var x = this._mstream(mnode);
      x.pipe(r);

    }.bind(this));
  }.bind(this));

};


Dcat.prototype._checkMnodeUrl = function(mnode, callback) {
  var murl = mnode.node.contentUrl || mnode.node.downloadUrl;
  if (!murl) {
    return callback(new Error('could not find the resource to publish (no file and no valid URL)'));
  }

  murl = this.url(murl);
  this.log('HEAD', murl);
  //see https://developer.github.com/v3/#user-agent-required
  request.head({url:murl, followAllRedirects:true, headers: {'User-Agent': 'dcat'}}, function(err, resp){
    if (err) return callback(err);
    this.log(resp.statusCode, murl);
    if (resp.statusCode >= 400) {
      return callback(this._error('could not HEAD ' + murl), resp.statusCode);
    }

    callback(null);
  }.bind(this));
};


Dcat.prototype._mstream = function(mnode){

  var mymime = mnode.node.encodingFormat || mnode.node.fileFormat;
  if (mnode.node.filePath) {
    if (/\.tar\.gz$/.test(mnode.node.filePath)) {
      mymime = 'application/x-gtar';
    } else {
      mymime = mime.lookup(mnode.node.filePath);
    }
  } else { //no filePath => hasPart => tar.gz
    mymime = 'application/x-gtar';
  }

  var isDirectory = !! (!mnode.node.filePath);
  var isContentEncodingGzip = !! (mymime.split(';')[0].trim().split('/')[0] === 'text');

  var mstream;

  if (isDirectory) {
    mstream = zlib.createGzip();

    var pack = tar.pack();
    pack.pipe(mstream); //we need to have pack being drained right away see https://github.com/mafintosh/tar-stream/issues/9

    var parts = Array.isArray(mnode.node.hasPart)? mnode.node.hasPart : [mnode.node.hasPart];
    var absPaths = parts
      .filter(function(x){ return x.filePath; })
      .map(function(x){ return path.resolve(this.root, x.filePath); }, this);

    async.eachSeries(absPaths, function(absPath, cb){
      fs.stat(absPath, function(err, stats){
        if (err) return cb(err);
        var s = pack.entry({
          name: path.relative(this.root, absPath),
          size: stats.size,
          mtime: stats.mtime }, cb);
        fs.createReadStream(absPath).pipe(s);
      }.bind(this));
    }.bind(this), function(err){
      if (err) {
        process.nextTick(function(){ pack.emit('error', err); });
      } else {
        pack.finalize();
      }
    });

  } else {

    mstream = fs.createReadStream(path.resolve(this.root, mnode.node.filePath));
    if (isContentEncodingGzip) {
      mstream = mstream.pipe(zlib.createGzip());
    }

  }

  mstream.isTarGz = isDirectory;
  mstream.isContentEncodingGzip = isContentEncodingGzip;

  return mstream;
};


Dcat.prototype.checksum = function(s, callback){
  callback = once(callback);

  var sha1 = crypto.createHash('sha1');
  var md5 = crypto.createHash('md5');
  var size = 0;
  s.on('data', function(d) {
    size += d.length;
    sha1.update(d);
    md5.update(d);
  });
  s.on('error', callback);
  s.on('end', function() {
    digestSha1 = sha1.digest('base64');
    digestMd5 = md5.digest('base64');

    var checksum = [
      { '@type': 'Checksum', checksumAlgorithm: 'SHA-1', checksumValue: digestSha1 },
      { '@type': 'Checksum', checksumAlgorithm: 'MD5', checksumValue: digestMd5 }
    ];

    return callback(null, checksum, size, (new Buffer(digestSha1, 'base64')).toString('hex'), digestMd5);
  });
};

//TODO: implement (or not) ???
Dcat.prototype._archiveUrl = function(mnode, callback){
  callback(null);
};


Dcat.prototype.unpublish = function(docUri, callback){

  var rurl = this.url(docUri);
  this.log('DELETE', rurl);
  request.del({url: rurl, auth: this._auth(), json:true}, function(err, resp, body){
    if (err) return callback(err);
    this.log(resp.statusCode, rurl);
    if (resp.statusCode >= 400){
      return callback(this._error(body, resp.statusCode));
    }
    callback(null, body, resp.statusCode);
  }.bind(this));

};


Dcat.prototype.get = function(docUri, opts, callback){
  if (arguments.length === 2){
    callback = opts;
    opts = {};
  } else {
    opts = clone(opts);
  }

  opts.profile = opts.profile || 'compacted';
  if (opts.normalize) {
    opts.profile = 'compacted';
  }

  var uri = this.url(docUri);
  this.log('GET', uri);
  request.get({url: uri, headers:{'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#' + opts.profile +'"'}}, function(err, resp, doc){
    if (err) return callback(err);
    this.log(resp.statusCode, uri);
    if (resp.statusCode >= 400){
      return callback(this._error(doc, resp.statusCode));
    }

    var ctxUrl = this.url('');

    //check if the server could satisfy the option and if so return
    if ( ((opts.profile === 'expanded') && Array.isArray(doc)) ||
         ((opts.profile === 'flattened') && ('@context' in doc) && ('@graph' in doc)) ||
         ((opts.profile === 'compacted') && ('@context' in doc))
       ) {

      if (opts.normalize) {
        if (doc['@context'] === SchemaOrgIo.contextUrl) {
          doc['@context'] = ctxUrl;
        }
        jsonld.normalize(doc, {format: 'application/nquads'}, callback);
      } else {
        callback(null, doc);
      }
      return;
    }

    //the server could not satisfy the option we suppose we got a JSON doc
    var ctxUrlFromLink;
    if (resp.headers.link){
      var links = jsonld.parseLinkHeader(resp.headers.link);
      if ('http://www.w3.org/ns/json-ld#context' in links){
        ctxUrlFromLink = links['http://www.w3.org/ns/json-ld#context'].target;
      };
    }

    if (!ctxUrlFromLink && !doc['@context']){
      return callback(new Error('The server could not provide a valid JSON-LD document. See http://www.w3.org/TR/json-ld/'))
    } else if (ctxUrlFromLink && !doc['@context']) {
      doc['@context'] = ctxUrlFromLink;
    }

    var ctx;
    if (doc['@context'] === SchemaOrgIo.contextUrl) {//context transfo to help for testing
      ctx = doc['@context'];
      doc['@context'] = ctxUrl;
    }

    function _next(err, pdoc) {
      if (err) return callback(err);

      //reverse @context transfo
      if (ctx && pdoc['@context'] === ctxUrl) {
        pdoc['@context'] = ctx;
      }

      callback(null, pdoc);
    };

    if (opts.normalize) {
      jsonld.normalize(doc, {format: 'application/nquads'}, _next);
    } else if (opts.profile === 'flattened') {
      jsonld.flatten(doc, doc['@context'], _next);
    } else if (opts.profile === 'expanded') {
      jsonld.expand(doc, {expandContext: doc['@context']}, _next);
    } else {
      jsonld.compact(doc, doc['@context'], _next);
    }

  }.bind(this));
};


/**
 * abs path where a document at the CURIE is being stored
 */
Dcat.prototype.docRoot = function(curie){
  var purl = url.parse(this.url(curie));
  return path.join(this.root, purl.hostname, purl.pathname);
};

Dcat.prototype.clone = function(docUri, opts, callback){
  if (arguments.length === 2){
    callback = opts;
    opts = {};
  }

  this.get(docUri, opts, function(err, doc){
    if (err) return callback(err);

    var root = this.docRoot(doc['@id']);

    _mkdirp(root, opts, function(err){
      if (err) return callback(err);

      //write all the files to disk (TODO cache URLs ???)
      var mnodes = this._mnodes(doc).filter(function(mnode){
        return (
          (mnode.node.contentUrl || mnode.node.downloadUrl) &&
          (mnode.node.filePath || (mnode.node.hasPart && mnode.node.hasPart.some(function(x){return x.filePath;})))
        );
      });

      async.each(mnodes, function(mnode, cb){
        this._mdl(mnode, root, opts, cb);
      }.bind(this), function(err){
        if (err) return callback(err);
        fs.writeFile(path.join(root, 'JSONLD'), JSON.stringify(doc, null, 2), function(err){
          callback(err, doc);
        });
      }.bind(this));

    }.bind(this));
  }.bind(this));

};

/**
 * download and write raw data of mnode on disk
 */
Dcat.prototype._mdl = function(mnode, root, opts, callback){
  callback = once(callback);
  var uri = this.url(mnode.node.contentUrl || mnode.node.downloadUrl);
  var ropts = {url: uri, json: null, encoding: null};
  this.log('GET', uri);

  //create all the dirs first (mikeal/request streaming will break if pipe is not on the same tick :(
  var paths;
  if (mnode.node.filePath) {
    paths = [mnode.node.filePath];
  } else if (mnode.node.hasPart) {
    var parts = Array.isArray(mnode.node.hasPart)? mnode.node.hasPart : [mnode.node.hasPart];
    paths = parts.filter(function(x){ return x.filePath; }).map(function(x){ return x.filePath;});
  }

  async.each(_.uniq(paths.map(function(p){ return path.join(root, path.dirname(p)); })), mkdirp, function(err){
    if (err) return callback(err);

    var r = request.get(ropts);
    r.on('error', callback);
    r.on('response', function(resp){
      this.log(resp.statusCode, uri);

      var that = this;
      if (resp.statusCode >= 400) {
        return resp.pipe(concat(function(body){
          callback(that._error(JSON.parse(body), resp.statusCode));
        }));
      }

      if (mnode.node.filePath) {

        var ws = fs.createWriteStream(path.join(root, mnode.node.filePath));
        ws.on('error', callback)
        ws.on('finish', callback);

        var encoding = resp.headers['content-encoding']
        if (encoding == 'gzip') {
          resp.pipe(zlib.createGunzip()).pipe(ws);
        } else if (encoding == 'deflate') {
          resp.pipe(zlib.createInflate()).pipe(ws);
        } else {
          resp.pipe(ws);
        }

      } else {

        var extract = tar.extract();
        extract.on('entry', function(header, rs, cb) {
          if (~paths.indexOf(header.name)) {
            var ws = rs.pipe(fs.createWriteStream(path.join(root, header.name)));
            ws.on('finish', cb);
          } else {
            rs.resume(); // auto drain the stream
            rs.on('end', cb);
          }
        });
        extract.on('error', callback);
        extract.on('finish', callback);
        resp.pipe(zlib.createGunzip()).pipe(extract);

      }

    }.bind(this));

  }.bind(this));

};

Dcat.prototype.lsMaintainer = function(curie, callback){
  var namespace = this.namespace(curie);
  var rurl = this.url('maintainers/ls/' + namespace);
  this.log('GET', rurl);
  request.get(rurl, function(err, resp, body){
    if(err) return callback(err);
    this.log(resp.statusCode, rurl);

    if(resp.statusCode >= 400){
      return callback(this._error(body, resp.statusCode));
    }

    callback(null, body);
  }.bind(this));
};

Dcat.prototype.addMaintainer = function(data, callback){
  data = clone(data);
  data.namespace = this.namespace(data.namespace); //if CURIE was provided
  if (!data.username && !data.namespace) {
    return callback(new Error('invalid data, data must contain username and namespace properties'));
  }

  var rurl = this.url('maintainers/add/' + data.username + '/' + data.namespace);
  this.log('POST', rurl);
  request.post({url: rurl, auth: this._auth()}, function(err, resp, body){
    if(err) return callback(err);
    this.log(resp.statusCode, rurl);
    if(resp.statusCode >= 400){
      return callback(this._error(body, resp.statusCode));
    }
    callback(null, body);
  }.bind(this));
};

Dcat.prototype.rmMaintainer = function(data, callback){
  data = clone(data);
  data.namespace = this.namespace(data.namespace); //if CURIE was provided
  if (!data.username && !data.namespace) {
    return callback(new Error('invalid data, data must contain username and namespace properties'));
  }
  var rurl = this.url('maintainers/rm/' + data.username + '/' + data.namespace);
  this.log('POST', rurl);
  request.post({url: rurl, auth: this._auth()}, function(err, resp, body){
    if(err) return callback(err);
    this.log(resp.statusCode, rurl);
    if(resp.statusCode >= 400){
      return callback(this._error(body, resp.statusCode));
    }
    callback(null, body);
  }.bind(this));
};


function _mkdirp(dirPath, opts, callback){
  if (arguments.length === 2){
    callback = opts;
    opts = {};
  }

  fs.exists(dirPath, function(exists){
    if (exists){
      if (opts.force) {
        rimraf(dirPath, function(err){
          if (err) return callback(err);
          mkdirp(dirPath, callback);
        });
      } else {
        callback(new Error(dirPath + ' already exists, run with --force to overwrite'));
      }
    } else {
      mkdirp(dirPath, callback);
    }
  });
};
