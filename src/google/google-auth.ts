import { google } from 'googleapis';
import { config } from '../config';

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
];

function createAuthClient() {
  return new google.auth.JWT({
    email: config.google.serviceAccountEmail,
    key: config.google.serviceAccountPrivateKey,
    scopes: SCOPES,
  });
}

export function createDocsClient() {
  return google.docs({ version: 'v1', auth: createAuthClient() });
}

export function createDriveClient() {
  return google.drive({ version: 'v3', auth: createAuthClient() });
}
