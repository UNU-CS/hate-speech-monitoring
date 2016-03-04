// While monitor.js is intended to be used interactively, this is better suited
// to being a long-running process that can be restarted automatically.
var m = require('./monitor.js');

m.load_state(function(ignored_err) {
  // ignored error occurs if there is no saved state, for example
  m.start({
    access_token: 'APP_ID|APP_SECRET',
    sources: [
      'some_fb_page',
      'some_fb_group',
      'not_a_user_though',
      'nytimes'
    ]
  });

  setInterval(m.export_all, 1000*60*60*6);
});

