// GET /api/auth-me — returns current login + trial/subscription status for the gate on the
// frontend to decide what to show (auth modal / paywall / the app itself).
const { getUserFromRequest, userStatus } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await getUserFromRequest(req);
    res.status(200).json(userStatus(user));
  } catch (e) {
    res.status(200).json({ loggedIn: false, accessGranted: false });
  }
};
