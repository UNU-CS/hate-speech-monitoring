Configure by editing the `config` object and `state.sources`. Run with
```bash
~/hate-speech-monitoring $ node
> var m = require('./monitor');
> m.start();
...
> m.export_all();
```
Check `m.debug` for other options.
