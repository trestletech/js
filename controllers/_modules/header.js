var HeaderController = Composer.Controller.extend({
	inject: 'header',

	elements: {
		'.actions-container': 'el_actions'
	},

	events: {
		'click a.logo': 'toggle_sidebar',
		'click .actions li': 'fire_action'
	},

	actions: [],

	init: function()
	{
		this.render();
		this.with_bind(turtl.events, 'header:set-actions', this.set_actions.bind(this));
	},

	render: function()
	{
		this.html(view.render('modules/header/index', {
			logged_in: turtl.user.logged_in,
			actions: this.actions
		}));
		this.render_actions();
	},

	render_actions: function()
	{
		var content = view.render('modules/header/actions', {
			actions: this.actions
		});
		this.el_actions.set('html', content);
	},

	set_actions: function(actions)
	{
		this.actions = actions;
		this.render_actions();

		var con = this.get_subcontroller('menu-actions');
		if(con) con.release();

		if(!actions) return;

		var menu = actions.filter(function(act) {
			return act.name == 'menu';
		})[0];
		if(menu)
		{
			var menu_el = this.el.getElement('.menu-actions');
			this.track_subcontroller('menu-actions', function() {
				return new ItemActionsController({
					inject: menu_el,
					actions: menu.actions,
					add_url: true
				});
			}.bind(this));
		}
	},

	toggle_sidebar: function(e)
	{
		if(e) e.stop();
		turtl.events.trigger('sidebar:toggle');
	},

	fire_action: function(e)
	{
		if(!e) return;
		var li = Composer.find_parent('li', e.target);
		var rel = li && li.get('rel');
		if(rel == 'menu') return;
		e.stop();
		if(!rel) return;
		turtl.events.trigger('header:fire-action', rel);
	}
});

