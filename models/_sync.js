"use strict";
var Sync = Composer.Model.extend({
	// local model ID tracking (for preventing double syncs)
	sync_ignore: {
		local: [],
		remote: []
	},

	// if false, syncing functions will no longer run
	enabled: false,

	// some polling vars
	connected: true,
	_polling: false,

	// holds collections that are responsible for handling incoming data syncs
	// from the API
	local_trackers: {},

	// used to track local syncs
	local_sync_id: 0,

	init: function()
	{
	},

	/**
	 * Instruct the syncing system to start
	 */
	start: function()
	{
		this.enabled = true;
		this.bind('db->mem', this.sync_db_to_mem.bind(this), 'sync:model:db->mem');
		this.bind('mem->db', this.run_outgoing_sync.bind(this), 'sync:model:mem->db');
		this.bind('api->db', this.run_incoming_sync.bind(this), 'sync:model:api->db');
		this.start_remote_poll();
	},

	/**
	 * Instruct the syncing system to stop
	 */
	stop: function()
	{
		this.enabled = false;
		this.unbind('db->mem', 'sync:model:db->mem');
		this.unbind('mem->db', 'sync:model:mem->db');
		this.unbind('api->db', 'sync:model:api->db');
		this.stop_remote_poll();
	},

	/**
	 * setup up a name -> collection maping that takes changes from the database
	 * and syncs them to the respective in-mem data
	 */
	register_local_tracker: function(name, tracker)
	{
		this.local_trackers[name] = tracker;
	},

	/**
	 * This function (mainly called by Composer.sync) tells the sync system to
	 * ignore a model on the next sync.
	 */
	ignore_on_next_sync: function(id, options)
	{
		options || (options = {});
		if(!options.type) options.type = 'local';
		this.sync_ignore[options.type].push(id);
	},

	/**
	 * See ignore_on_next_sync() ...this is the function the sync processes use
	 * to determine if an item should be ignored.
	 */
	should_ignore: function(ids, options)
	{
		options || (options = {});
		if(!options.type) options.type = 'local';
		if(!(ids instanceof Array)) ids = [ids];
		var ignores = this.sync_ignore[options.type];
		for(var i = 0; i < ids.length; i++)
		{
			var id = ids[i];
			if(!id && id !== 0) continue;
			if(ignores.contains(id))
			{
				log.debug('sync: ignore: '+ options.type, id);
				ignores.erase(id);
				return true;
			}
		}
		return false;
	},

	/**
	 * Persist the sync state. This lets us pick up where we left off when a
	 * client closes and re-opens later, grabbing all changes that occurred
	 * inbetween.
	 */
	save: function()
	{
		if(!turtl.db || !turtl.db.sync) return false;

		var sync_id = this.get('sync_id');
		turtl.db.sync.update(
			{key: 'sync_id', value: sync_id}
		).catch(function(err) {
			log.error('Sync.save: problem persisting sync record: ', derr(err));
		});
	},

	/**
	 * Notify the syncing system that data has changed locally and needs to be
	 * synced to the API.
	 */
	queue_outgoing_change: function(table, action, data)
	{
// TODO: re-enable when we care about remote syncing
return false;
		var msg = {
			type: table,
			action: action,
			data: data
		};
		var fail_count = 0;
		var enqueue = function()
		{
			turtl.db.sync_outgoing.add(msg).bind(this)
				.then(function() {
					log.debug('sync: queue remote: send: ', msg);
					this.trigger('mem->db');
				})
				.catch(function(err) {
					log.error('sync: queue remote: error: ', derr(err));
					fail_count++;
					if(fail_count < 3) enqueue.delay(100, this);
				});
		}.bind(this);
		enqueue();
	},

	sync_db_to_mem: function()
	{
	},

	run_outgoing_sync: function()
	{
	},

	run_incoming_sync: function()
	{
	},

	start_remote_poll: function()
	{
		var sync_id = this.get('sync_id', false);
		// if we don't ahve a sync_id, load it from the DB
		(sync_id ? Promise.resolve({value: sync_id}) : turtl.db.sync.get('sync_id'))
			.bind(this)
			.then(function(rec) {
				this.set({sync_id: rec ? rec.value : null})
				this._remote_poll = setInterval(this.poll_api_for_changes.bind(this), 10000);
			})
			.catch(function(err) {
				log.error('sync: problem grabbing sync_id: ', derr(err));
			});
	},

	stop_remote_poll: function()
	{
		clearInterval(this._remote_poll);
	},

	poll_api_for_changes: function(options)
	{
		options || (options = {});

		if(!turtl.user || !turtl.user.logged_in) return false;
		if(!turtl.poll_api_for_changes) return false;

		this._polling = true;
		var failed = false;
		return this.get('/api/v2/sync?immediate='+(options.immediate ? 1 : 0), null, {timeout: 80000}).bind(this)
			.then(function(sync) {
				if(!this.connected && !options.skip_notify) turtl.events.trigger('api:connect');
				this.connected = true;
				return this.update_local_db_from_api_sync(sync);
			})
			.catch(function() {
				failed = true;
				if(this.connected && !options.skip_notify) turtl.events.trigger('api:disconnect');
				this.connected = false;
			})
			.finally(function() {
				this._polling = false;
				if(failed)
				{
					setTimeout(this.monitor.bind(this, {immediate: true}), 15000);
				}
				else
				{
					this.monitor();
				}
			});
	},

	transform: function(item)
	{
		var type = item._sync.type;

		if(type == 'user')
		{
			item.key = 'user';
		}

		if(type == 'note')
		{
			if(item.board_id)
			{
				item.boards = [item.board_id];
				delete item.board_id;
			}
		}

		return item;
	},

	type_to_table: function(typename)
	{
		var names = {
			user: 'user',
			keychain: 'keychain',
			persona: 'personas',
			board: 'boards',
			note: 'notes',
			file: 'files'
		};
		return names[typename];
	},

	update_local_db_from_api_sync: function(sync_collection, options)
	{
		options || (options = {});

		var sync_id = sync_collection.sync_id;
		var records = sync_collection.records;
		return new Promise(function(resolve, reject) {
			var next = function()
			{
				var item = records.splice(0, 1)[0];
				if(!item) return resolve(sync_id);
				item = this.transform(item);
				var sync = item._sync;
				delete item._sync;
				var table = this.type_to_table(sync.type);
				if(!table)
				{
					return reject(new Error('sync: api->db: error processing sync item (bad _sync.type): ', sync));
				}

				return turtl.db[table].update(item)
					.then(next)
					.catch(function(err) {
						log.error('sync: api->db: error saving to table: ', table, err);
						throw err;
					});
			}.bind(this);
			next();
		}.bind(this));
	}
});

var SyncCollection = Composer.Collection.extend({
});

