'use strict';

var _ = require('underscore');
var JuttleMoment = require('../../runtime/types/juttle-moment');
var oops_fanin = require('./oops-fanin');

var BATCH_OF_BATCHES = 1000;

class periodic_fanin extends oops_fanin {
    // mixin functions so batch and windowed reduce can share the ability
    // to track periodic intervals in timeseries and trigger actions
    // when crossing epoch boundaries. Mixers need to define process_points(),
    // which is called by process() while ingesting points in the current epoch.
    //
    // to keep you on your toes, these mixins swallow eof() so derived
    // classes that implement eof() will break.  instead, this class
    // calls periodic_eof() so implement that instead.
    constructor(options, params, location, program) {
        super(options, params, location, program);
        this.epoch = this.next_epoch = undefined;
        this.dead = false;
        // is this mixin mixed in?
        this.periodic = true;
        // child should override these (and call init_warnings):
        // a duration
        this.interval = null;
        // an optional alignment moment
        this.on = null ;

        // queue in case we're in the midst of a large batch-loop.
        // (see advance() below for details)
        this.post_batch_queue = [];
        this.post_batch_time = null;
        this.post_batch_eof = false;
        this.in_batch_loop = false;
    }
    init_warnings() {
        // call after the proc name and interval have been established
        var self = this;
        this.warn_drop = _.throttle(function() {
            self.trigger('warning', self.runtime_error('POINTS-OUT-OF-ORDER', { proc: this.procName() }));
        }, this.interval.milliseconds());
        this.warn_timeless = _.once(function() {
            self.trigger('warning', self.runtime_error('TIMELESS-POINTS'));
        });
    }
    teardown() {
        this.dead = true;
    }
    mark(mark, from) {
        // ignore upstream marks, except for advancing time
        this.advance(mark.time);
    }
    process_points(points) {
        // consume points, all in the same epoch
        throw new Error('write me!');
    }
    _process_helper(points) {
        var arr = points;
        var process_fun;

        process_fun = _.bind(this.process_points, this);

        function wrap(arr) {
            return [{time: _.last(arr).time, arr: arr}];
        }
        // consume arr, advancing time and watching for an epoch
        if (arr.length === 0) { return; }

        if (this.in_batch_loop) {
            this.post_batch_queue = this.post_batch_queue.concat(wrap(arr));
            return;
        }

        var out = [];
        for (var k = 0; k < arr.length; ++k) {
            var pt = arr[k];
            if (pt.hasOwnProperty('time')) {
                if (this.epoch && pt.time.lt(this.epoch)) {
                    this.warn_drop();
                    continue;
                }
                if (out.length > 0 && pt.time.gte(this.next_epoch)) {
                    process_fun(out);
                    out = [];
                }
                var finished = this.advance(pt.time);
                if (!finished) {
                    this.post_batch_queue = this.post_batch_queue.concat(wrap(arr.slice(k)));
                    break;
                }
            } else {
                this.warn_timeless();
            }

            // XXX could optimize common case to avoid copying in
            // common case where out ends up being exactly the same
            // as incoming arr
            out.push(pt);
        }

        if (out.length > 0) {
            process_fun(out);
        }

        return out;
    }
    process(points) {
        this._process_helper(points);
    }
    advance(time) {
        if (this.in_batch_loop) {
            this.post_batch_time = this.post_batch_time
                ? JuttleMoment.max(time, this.post_batch_time) : time;
            return false;
        }
        if (this.next_epoch === undefined) {
            // our first epoch comes from the passed-in time
            this.next_epoch = JuttleMoment.quantize(time, this.interval, this.on);
        }
        return this._advance(time);
    }

    _advance(time) {
        var self = this;
        var n = 0;
        while (time.gte(this.next_epoch)) {
            if (n++ === BATCH_OF_BATCHES) {
                this.in_batch_loop = true;
                setTimeout(function() {
                    try {
                        self._advance(time);
                    }
                    catch (error) {
                        self.logger.error('Caught error', error);
                    }
                }, 0);
                return false;
            }

            if (!this.epoch) {
                this.first_epoch(this.next_epoch);
            } else {
                this.other_epoch(this.next_epoch);
            }

            this.epoch = this.next_epoch;
            this.next_epoch = JuttleMoment.add(this.epoch, this.interval);
        }

        if (this.in_batch_loop) {
            this.in_batch_loop = false;

            var q = this.post_batch_queue;
            this.post_batch_queue = [];

            var tm;
            if (q.length > 0) {
                tm = _.last(q).time;
                _.each(q, function(pts) {
                    self._process_helper(pts.arr);
                });
            }
            if (this.post_batch_time !== null && tm !== undefined) {
                tm = JuttleMoment.max(tm, this.post_batch_time);
            }

            var finished = this.advance(tm);
            if (finished && this.post_batch_eof) {
                this.periodic_eof();
            }
        }

        return true;
    }
    eof() {
        if (this.in_batch_loop) {
            this.post_batch_eof = true;
        }
        else {
            this.periodic_eof();
        }
    }
    first_epoch(epoch) {
        // by default,  first epoch is like any other.
        // this is here to be overridden.
        var out = this.advance_epoch(epoch);
        this.emit(out);
    }

    other_epoch(epoch) {
        var out = this.advance_epoch(epoch);
        this.emit(out);
    }

    advance_epoch(epoch) {
        throw new Error('write me!');
    }
}

module.exports = periodic_fanin;
