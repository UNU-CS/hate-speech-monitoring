/* eslint camelcase: "off", no-console: "off" */
'use strict';

var graph = require('fbgraph');
var _ = require('underscore');
var json2csv = require('json2csv');
var async = require('async');
var fs = require('fs');

var config = {
  version: '2.5',
  post_limit: 25,
  // If comment_limit is too big, you may get errors stating "Please reduce the
  // amount of data you're asking for, then retry your request"
  comment_limit: 500,
  refresh_interval_ms: 1000 * 60,
  backup_interval_ms: 1000 * 60 * 10,
  alive_age_ms: 1000 * 60 * 60 * 24,
  state_backup_file: './monitor.backup',
  post_export_file: './monitor_posts.csv',
  comment_export_file: './monitor_comments.csv',
  access_token: 'APP_ID|APP_SECRET',
  sources: [
    'some_fb_page',
    'some_fb_group',
    'not_a_user_though',
    'nytimes'
  ],
  debug: false
};

var state = {
  requests: [],
  live_posts: {},
  posts: {},
  comments: {}
};

var post_params = {
  // eslint-disable-next-line max-len
  fields: 'id,created_time,updated_time,message,comments.summary(true).filter(stream),likes.summary(true),shares',
  limit: config.post_limit
};

var comment_params = {
  fields: 'id,created_time,from,likes.summary(true),message',
  limit: config.comment_limit,
  filter: 'stream' // Get comment replies too
};

// Read nested value (i.e. obj.k1.k2.k3.k4) from object, returning undefined
// rather than an error if any key in the sequence does not exist.
function safe_get(obj, key_arr) {
  if (_.isUndefined(obj)) {
    return obj;
  }

  if (key_arr.length === 0) {
    return obj;
  }

  var next_key = key_arr.pop();
  return safe_get(obj[next_key], key_arr);
}

function format_post(source_id) {
  return function(post) {
    return {
      source_id: source_id,
      id: post.id,
      created_time: post.created_time,
      updated_time: post.updated_time,
      likes: safe_get(post, ['likes', 'summary', 'total_count']),
      comments: safe_get(post, ['comments', 'summary', 'total_count']),
      shares: post.shares ? post.shares.count
                          : 0,
      message: post.message
    };
  };
}

function format_comment(post_id) {
  return function(comment) {
    return {
      post_id: post_id,
      id: comment.id,
      created_time: comment.created_time,
      from_id: safe_get(comment, ['from', 'id']),
      likes: safe_get(comment, ['likes', 'summary', 'total_count']),
      message: comment.message
    };
  };
}

function log_with_timestamp(o) {
  console.error('[' + (new Date()).toString() + '] ', o);
}

function handle_error(err, obj) {
  if (!err) {
    return;
  }

  if (typeof err === 'object') {
    log_with_timestamp(err);
    err = err.message;
  } else {
    err = err.toString();
    log_with_timestamp(err);
  }

  if (obj) {
    console.error(obj);
  }

  if (config.debug) {
    throw new Error(err);
  }
}

function record_request() {
  state.requests.push(new Date());
}

function log_requests() {
  state.requests = state.requests.filter(function(when) {
    var ms_per_hour = 1000 * 60 * 60;
    return new Date() - when < ms_per_hour;
  });
  console.log(state.requests.length + ' requests in the last hour.');
}

function updated_recently(post) {
  return new Date() - new Date(post.updated_time) < config.alive_age_ms;
}

function get(path, params, after, callback) {
  if (after) {
    params = _.clone(params);
    params.after = after;
  }

  graph.get(path, params, function(err, res) {
    if (err && err.is_transient) {
      console.log('Got a transient error; retrying ' + path);
      return get(path, params, after, callback);
    }

    // eslint-disable-next-line max-len
    var missing_object_regex = /Object with ID .+ does not exist, cannot be loaded due to missing permissions, or does not support this operation/;
    if (err && missing_object_regex.test(err.message)) {
      return console.log(
        'Warning: Object at ' + path + ' has likely been removed from ' +
        'Facebook. Further updates will not be collected. It is possible, ' +
        'however, that the object is still there, and this is caused by an ' +
        'incorrect request made by this tool');
    }

    if (err) {
      console.error('Got an error while processing ' + path);
      return handle_error(err, { params: params, res: res });
    }

    if (!res) {
      return handle_error('No response object!');
    }

    record_request();
    callback(res);
    module.exports.debug.res = res;
  });
}

// Takes an array of objects of the form
//   [ {id: 'foo', ...}, {id: 'bar', ...}, ...]
// and produces
//   { 'foo': {id: 'foo', ...},
//     'bar': {id: 'bar', ...} }
function use_ids_as_keys(arr) {
  var ids = _.map(arr, function(obj) {
    return obj.id;
  });
  return _.object(_.zip(ids, arr));
}

function get_comments(post_id, after, callback) {
  get('/' + post_id + '/comments', comment_params, after, function(res) {
    console.log('Got ' + res.data.length + ' comments');
    var new_comments_arr = _.map(res.data, format_comment(post_id));
    state.comments = _.extend(state.comments,
                              use_ids_as_keys(new_comments_arr));

    if (res && res.paging && res.paging.cursors && res.paging.cursors.after) {
      var new_after = res.paging.cursors.after;
      if (after !== new_after) {
        get_comments(post_id, new_after, callback);
      }
    } else {
      console.log('Got all comments.');
      callback();
    }
  });
}

// Just the last 25
function get_posts(source_id) {
  get('/' + source_id + '/feed', post_params, null, function(res) {
    console.log('Got ' + res.data.length + ' posts from ' + source_id);

    var post_records = _.map(res.data, format_post(source_id));

    _.each(post_records, function(post) {
      var maybe_new_comments = !state.posts[post.id] ||
                               state.posts[post.id].updated_time !==
                               post.updated_time;
      if (maybe_new_comments) {
        state.live_posts[post.id] = post;
      }
      state.posts[post.id] = post;
    });
  });
}

function get_all_comments(post, callback) {
  // By passing null here, the first request gets the oldest comments, and
  // recursive requests get all of them.
  get_comments(post.id, null, callback);
}

function prune_posts() {
  var alive_and_dying = _.partition(_.values(state.live_posts),
                                    updated_recently);
  state.live_posts = use_ids_as_keys(alive_and_dying[0]);
  async.each(alive_and_dying[1], get_all_comments);
  console.log('Pruned ' + alive_and_dying[1].length + ' posts. ' +
              alive_and_dying[0].length + ' posts remain alive.');
}

function check_all_sources() {
  _.each(config.sources, get_posts);
}

var save = fs.writeFile;

// Save the state of this tool so it can be restarted easily.
function export_state(filename) {
  if (!filename) {
    filename = config.state_backup_file;
  }
  save(filename, JSON.stringify(state), handle_error);
}

function load_state(filename, callback) {
  if (typeof filename === 'function') {
    callback = filename;
    filename = null;
  }

  if (!filename) {
    filename = config.state_backup_file;
  }

  fs.readFile(filename, function(err, data) {
    if (err && callback) {
      return callback(err);
    }

    if (err) {
      return handle_error(err);
    }

    state = JSON.parse(data);
    console.log('Loaded state from ' + filename + ' successfully');

    if (callback) {
      callback();
    }
  });
}

function save_live_post_comments(callback) {
  async.each(state.live_posts, get_all_comments, callback);
}

function save_csv(filename, obj) {
  var arr = _.values(obj);
  json2csv({ data: arr, fields: _.keys(arr[0]) }, function(err, csv) {
    if (err) {
      return handle_error(err);
    }
    save(filename, csv, handle_error);
  });
}

// Export all data as two csv files, including comments from live posts
function export_all() {
  save_live_post_comments(function(err) {
    if (err) {
      return handle_error(err);
    }
    save_csv(config.post_export_file, state.posts);
    save_csv(config.comment_export_file, state.comments);
    console.log('Export complete');
  });
}

function initialize(new_config) {
  if (new_config) {
    config = _.extend(config, new_config);
  }
  graph.setVersion(config.version);
  graph.setAccessToken(config.access_token);
}

function start(new_config) {
  initialize(new_config);
  setInterval(check_all_sources, config.refresh_interval_ms);
  setInterval(prune_posts, config.refresh_interval_ms);
  setInterval(log_requests, config.refresh_interval_ms);
  setInterval(export_state, config.backup_interval_ms);
}

// Note: like most debug tools, you have to call monitor.debug.initialize()
// before this.
function test_sources() {
  var posts = 0;
  async.each(config.sources, function(source_id, callback) {
    get('/' + source_id + '/feed', post_params, null, function(res) {
      if (res.data.length === 0) {
        callback(new Error('Source ' + source_id + ' returned 0 posts'));
      } else {
        posts += res.data.length;
        callback();
      }
    });
  }, function(err) {
    if (err) {
      return handle_error(err);
    }
    console.log('Successfully got posts (' + posts + ') from all sources (' +
                config.sources.length + ').');
    if (config.sources.length * config.post_limit !== posts) {
      console.log('Warning: hoped to get ' +
                  config.sources.length * config.post_limit +
                  ' posts, but only got ' + posts + '.');
    }
  });
}

// For testing rate limits
function getlots(n) {
  _.each(_.range(n), function() {
    get('/nytimes/feed', post_params, null, log_requests);
  });
}

function get_state() {
  return state;
}

module.exports = {
  start: start,
  export_all: export_all,
  load_state: load_state,
  debug: {
    initialize: initialize,
    getlots: getlots,
    log_requests: log_requests,
    test_sources: test_sources,
    save_live_post_comments: save_live_post_comments,
    export_state: export_state,
    get_state: get_state
  }
};
