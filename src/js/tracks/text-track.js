import TextTrackCueList from './text-track-cue-list';
import * as Lib from '../lib';
import * as TextTrackEnum from './text-track-enums';
import EventEmitter from '../event-emitter';
import document from 'global/document';
import window from 'global/window';
import XHR from '../xhr.js';

/*
 * https://html.spec.whatwg.org/multipage/embedded-content.html#texttrack
 *
 * interface TextTrack : EventTarget {
 *   readonly attribute TextTrackKind kind;
 *   readonly attribute DOMString label;
 *   readonly attribute DOMString language;
 *
 *   readonly attribute DOMString id;
 *   readonly attribute DOMString inBandMetadataTrackDispatchType;
 *
 *   attribute TextTrackMode mode;
 *
 *   readonly attribute TextTrackCueList? cues;
 *   readonly attribute TextTrackCueList? activeCues;
 *
 *   void addCue(TextTrackCue cue);
 *   void removeCue(TextTrackCue cue);
 *
 *   attribute EventHandler oncuechange;
 * };
 */

let TextTrack = function(options) {
  options = options || {};

  if (!options['player']) {
    throw new Error('A player was not provided.');
  }

  let tt = this;
  if (Lib.IS_IE8) {
    tt = document.createElement('custom');

    for (let prop in TextTrack.prototype) {
      tt[prop] = TextTrack.prototype[prop];
    }
  }

  tt.player_ = options['player'];

  let mode = TextTrackEnum.TextTrackMode[options['mode']] || 'disabled';
  let kind = TextTrackEnum.TextTrackKind[options['kind']] || 'subtitles';
  let label = options['label'] || '';
  let language = options['language'] || options['srclang'] || '';
  let id = options['id'] || 'vjs_text_track_' + Lib.guid++;

  if (kind === 'metadata' || kind === 'chapters') {
    mode = 'hidden';
  }

  tt.cues_ = [];
  tt.activeCues_ = [];

  let cues = new TextTrackCueList(tt.cues_);
  let activeCues = new TextTrackCueList(tt.activeCues_);

  let changed = false;
  let timeupdateHandler = Lib.bind(tt, function() {
    this['activeCues'];
    if (changed) {
      this['trigger']('cuechange');
      changed = false;
    }
  });
  if (mode !== 'disabled') {
    tt.player_.on('timeupdate', timeupdateHandler);
  }

  Object.defineProperty(tt, 'kind', {
    get: function() {
      return kind;
    },
    set: Function.prototype
  });

  Object.defineProperty(tt, 'label', {
    get: function() {
      return label;
    },
    set: Function.prototype
  });

  Object.defineProperty(tt, 'language', {
    get: function() {
      return language;
    },
    set: Function.prototype
  });

  Object.defineProperty(tt, 'id', {
    get: function() {
      return id;
    },
    set: Function.prototype
  });

  Object.defineProperty(tt, 'mode', {
    get: function() {
      return mode;
    },
    set: function(newMode) {
      if (!TextTrackEnum.TextTrackMode[newMode]) {
        return;
      }
      mode = newMode;
      if (mode === 'showing') {
        this.player_.on('timeupdate', timeupdateHandler);
      }
      this.trigger('modechange');
    }
  });

  Object.defineProperty(tt, 'cues', {
    get: function() {
      if (!this.loaded_) {
        return null;
      }

      return cues;
    },
    set: Function.prototype
  });

  Object.defineProperty(tt, 'activeCues', {
    get: function() {
      if (!this.loaded_) {
        return null;
      }

      if (this['cues'].length === 0) {
        return activeCues; // nothing to do
      }

      let ct = this.player_.currentTime();
      let active = [];

      for (let i = 0, l = this['cues'].length; i < l; i++) {
        let cue = this['cues'][i];
        if (cue['startTime'] <= ct && cue['endTime'] >= ct) {
          active.push(cue);
        } else if (cue['startTime'] === cue['endTime'] && cue['startTime'] <= ct && cue['startTime'] + 0.5 >= ct) {
          active.push(cue);
        }
      }

      changed = false;

      if (active.length !== this.activeCues_.length) {
        changed = true;
      } else {
        for (let i = 0; i < active.length; i++) {
          if (indexOf.call(this.activeCues_, active[i]) === -1) {
            changed = true;
          }
        }
      }

      this.activeCues_ = active;
      activeCues.setCues_(this.activeCues_);

      return activeCues;
    },
    set: Function.prototype
  });

  if (options.src) {
    loadTrack(options.src, tt);
  } else {
    tt.loaded_ = true;
  }

  if (Lib.IS_IE8) {
    return tt;
  }
};

TextTrack.prototype = Lib.obj.create(EventEmitter.prototype);
TextTrack.prototype.constructor = TextTrack;

/*
 * cuechange - One or more cues in the track have become active or stopped being active.
 */
TextTrack.prototype.allowedEvents_ = {
  'cuechange': 'cuechange'
};

TextTrack.prototype.addCue = function(cue) {
  let tracks = this.player_.textTracks();

  if (tracks) {
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i] !== this) {
        tracks[i].removeCue(cue);
      }
    }
  }

  this.cues_.push(cue);
  this['cues'].setCues_(this.cues_);
};

TextTrack.prototype.removeCue = function(removeCue) {
  let removed = false;

  for (let i = 0, l = this.cues_.length; i < l; i++) {
    let cue = this.cues_[i];
    if (cue === removeCue) {
      this.cues_.splice(i, 1);
      removed = true;
    }
  }

  if (removed) {
    this.cues.setCues_(this.cues_);
  }
};

/*
 * Downloading stuff happens below this point
 */
let parseCues = function(srcContent, track) {
  if (typeof window['WebVTT'] !== 'function') {
    //try again a bit later
    return window.setTimeout(function() {
      parseCues(srcContent, track);
    }, 25);
  }

  let parser = new window['WebVTT']['Parser'](window, window['vttjs'], window['WebVTT']['StringDecoder']());

  parser['oncue'] = function(cue) {
    track.addCue(cue);
  };
  parser['onparsingerror'] = function(error) {
    Lib.log.error(error);
  };

  parser['parse'](srcContent);
  parser['flush']();
};

var loadTrack = function(src, track) {
  XHR(src, Lib.bind(this, function(err, response, responseBody){
    if (err) {
      return Lib.log.error(err);
    }


    track.loaded_ = true;
    parseCues(responseBody, track);
  }));
};

var indexOf = function(searchElement, fromIndex) {
  if (this == null) {
    throw new TypeError('"this" is null or not defined');
  }

  let O = Object(this);

  let len = O.length >>> 0;

  if (len === 0) {
    return -1;
  }

  let n = +fromIndex || 0;

  if (Math.abs(n) === Infinity) {
    n = 0;
  }

  if (n >= len) {
    return -1;
  }

  let k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);

  while (k < len) {
    if (k in O && O[k] === searchElement) {
      return k;
    }
    k++;
  }
  return -1;
};

export default TextTrack;
