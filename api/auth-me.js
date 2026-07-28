const { getUserFromRequest, userStatus } = require('../lib/auth');

module.exports = async function handler(req, res) {
  try {
    const user = await getUserFromRequest(req);
    res.status(200).json(userStatus(user));
  } catch (e) {
    console.error('auth-me error', e);
    res.status(200).json(userStatus(null));
  }
};
