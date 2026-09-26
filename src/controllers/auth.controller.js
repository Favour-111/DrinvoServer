import * as auth from '../services/auth.service.js';

export async function login(req, res) {
  res.json(await auth.login(req.body));
}

export async function signup(req, res) {
  res.status(201).json(await auth.signup(req.body));
}

export async function me(req, res) {
  res.json(await auth.me(req.user));
}

export async function changePassword(req, res) {
  res.json(await auth.changePassword(req.user, req.body));
}

export async function updateMe(req, res) {
  res.json(await auth.updateMe(req.user, req.body));
}
