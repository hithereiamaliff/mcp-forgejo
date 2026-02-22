/**
 * Firebase Analytics Module
 * 
 * Tracks MCP server usage metrics using Firebase Realtime Database.
 * Falls back gracefully if Firebase credentials are not configured.
 */

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

let db: admin.database.Database | null = null;
let analyticsEnabled = false;

export function initFirebase(): void {
  try {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentialsPath) {
      console.log('[Analytics] GOOGLE_APPLICATION_CREDENTIALS not set, analytics disabled');
      return;
    }

    const fullPath = path.resolve(credentialsPath);
    if (!fs.existsSync(fullPath)) {
      console.log(`[Analytics] Credentials file not found at ${fullPath}, analytics disabled`);
      return;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`,
      });
    }

    db = admin.database();
    analyticsEnabled = true;
    console.log('[Analytics] Firebase initialized successfully');
  } catch (err) {
    console.error('[Analytics] Failed to initialize Firebase:', err);
  }
}

export async function trackEvent(event: string, data?: Record<string, any>): Promise<void> {
  if (!analyticsEnabled || !db) return;

  try {
    const ref = db.ref('mcp-forgejo/events').push();
    await ref.set({
      event,
      timestamp: admin.database.ServerValue.TIMESTAMP,
      ...data,
    });
  } catch (err) {
    console.error('[Analytics] Failed to track event:', err);
  }
}

export async function trackToolCall(toolName: string, duration: number, success: boolean): Promise<void> {
  if (!analyticsEnabled || !db) return;

  try {
    const ref = db.ref('mcp-forgejo/tool_calls').push();
    await ref.set({
      tool: toolName,
      duration_ms: duration,
      success,
      timestamp: admin.database.ServerValue.TIMESTAMP,
    });

    // Update tool usage counter
    const counterRef = db.ref(`mcp-forgejo/tool_usage/${toolName}`);
    await counterRef.transaction((current: number | null) => (current || 0) + 1);
  } catch (err) {
    console.error('[Analytics] Failed to track tool call:', err);
  }
}

export async function getAnalyticsSummary(): Promise<any> {
  if (!analyticsEnabled || !db) {
    return { enabled: false, message: 'Analytics not configured' };
  }

  try {
    const usageSnap = await db.ref('mcp-forgejo/tool_usage').once('value');
    const eventsSnap = await db.ref('mcp-forgejo/events').limitToLast(10).once('value');

    return {
      enabled: true,
      tool_usage: usageSnap.val() || {},
      recent_events: eventsSnap.val() || {},
    };
  } catch (err) {
    return { enabled: true, error: String(err) };
  }
}

export function isAnalyticsEnabled(): boolean {
  return analyticsEnabled;
}
