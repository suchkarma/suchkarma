const express         = require('express');
const nunjucks        = require('nunjucks');
const passport        = require('passport');
const GoogleStrategy  = require('passport-google-oauth').OAuth2Strategy;
const morgan          = require('morgan');
const cookieParser    = require('cookie-parser');
const bodyParser      = require('body-parser');
const session         = require('express-session');
const favicon         = require('serve-favicon');

const mongo           = require('./mongo.js');
const config          = require('./config.js');
const filterMap       = require('./filters.js');

const app             = express();

passport.use(new GoogleStrategy({
    clientID: config.get('googleClientID'),
    clientSecret: config.get('googleClientSecret'),
    callbackURL: config.get('googleCallbackHost') + '/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    mongo
      .findOrCreateUser(profile)
      .then(e => done(null, e), done);
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

if (config.get('env') == 'development') {
  app.use(morgan('dev'));
}
else {
  app.use(morgan('common'));
}

app.use(cookieParser());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: 'keyboard cat',
  resave: false,
  saveUninitialized: true,
  cookie: {}
}));

app.use(favicon(__dirname + '/public/favicon.ico'));

app.use(express.static('public'));

app.use(passport.initialize());
app.use(passport.session());

app.set('view engine', 'nunj');

const env = nunjucks.configure('views', {
    autoescape: true,
    watch: config.get('env') == 'development',
    express: app,
});

Object.keys(filterMap).forEach((name) => {
  env.addFilter(name, filterMap[name]);
});

// adds the user object to the responses 'locals' object
// this is automatically available to templates
function userObjectMiddleware(req, res, next) {
  if (req.isAuthenticated()) {
    mongo
      .findUser(req.user)
      .then(e => res.locals.user = e)
      .then(null, e => console.log("findUser error:", e))
      .then(e => next());
  } else {
    next();
  }
}

app.use(userObjectMiddleware);

function errorHandler(res) {
  return err => res.status(500).render('error', { err });
}

app.get('/', (req, res) => res.render('index'));

app.get('/login', (req, res) => {
  res.render('login', { returnPath: req.query.returnPath });
});

app.get('/gief', ensureAuthenticated, (req, res) => {
  const me = res.locals.user;
  let location;
  if (req.query.lat && req.query.lng) {
    location = { lat: req.query.lat, lng: req.query.lng };
  }

  let stuff = [
    mongo.getOtherParties(me),
    location ? mongo.findBeacon(location.lat, location.lng, 1000) : null
  ];

  Promise
    .all(stuff)
    .then(([otherParties, closeParties]) => {
      res.render('gief', { otherParties, closeParties, location });
    })
    .then(null, errorHandler(res));
});

app.post('/gief', (req, res) => {
  const transaction = {
    to: req.body.to,
    from: res.locals.user._id,
    karma: req.body.karma
  };
  if (transaction.to && transaction.karma > 0) {
    // note: should've used .catch on promise, but not supperted. see
    // https://github.com/aheckmann/mpromise/issues/15
    mongo
      .transact(transaction)
      .then((e => res.redirect('/me')), errorHandler(res));
  } else {
    res.sendStatus(400);
  }
});

app.get('/auth/google', 
  (req, res, next) => {
    req.session.returnPath = req.query.returnPath;
    next();
  },
  passport.authenticate('google', {scope: ['profile', 'email']})
);

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login'
  }),
  (req, res, next) => {
    if (req.session.returnPath) {
      const rp = req.session.returnPath;
      req.session.returnPath = null;
      res.redirect(rp);
    } else {
      res.redirect('/me');
    }
    next();
  }
);

app.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    res.redirect('/login?returnPath=' + escape(req.originalUrl));
  }
}

app.get('/me', ensureAuthenticated, (req, res) => {
  const user = res.locals.user;
  Promise.all([
    mongo
      .getTransactions(user, 5)
      .then(ts => toViewTransactions(user, ts)),
    mongo
      .getOtherParties(user)
      .then(ps => toViewRecents(ps))
  ]).then(([transactions, others]) => {
    res.render('me', { transactions, friends: others.concat(user.friends).distinct });
  });
});

app.get('/transactions', ensureAuthenticated, (req, res) => {
  mongo
    .getTransactions(res.locals.user)
    .then(ts => toViewTransactions(res.locals.user, ts))
    .then(ts => res.render('transactions', { transactions: ts }));
});

app.get('/friends', ensureAuthenticated, (req, res) => {
  res.render('friends');
});

app.post('/befriend', ensureAuthenticated, (req, res) => {
  const u = res.locals.user;
  mongo
    .findOneUserOrCreate(req.body.email) // durtay!
    .then(e => {
      const eAdded = e.friends.addToSet(u);
      const uAdded = u.friends.addToSet(e);
      if (eAdded && uAdded) { 
        return Promise.all([e.save(), u.save()]);
      } else {
        return []; // User already befriended
      }
    })
    .then((e => res.redirect('/friends')), errorHandler(res));
});

function toViewTransactions(user, dbTransactions) {
  return dbTransactions.map(t => {
    if (t.to.email === user.email) {
      return {direction: 'got', to: t.to, from: t.from, amount: -t.karma, timestamp: t.when};
    } else {
      return {direction: 'gave', to: t.to, from: t.from, amount: t.karma, timestamp: t.when};
    }
  });
}

function toViewRecents(dbRecents) {
  return dbRecents.reverse();
}

app.listen(config.get('port'), () => {
  console.log("Node app is running at localhost:" + config.get('port'));
});
