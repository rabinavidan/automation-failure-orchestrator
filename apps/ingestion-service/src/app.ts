import express from 'express';
import { requestLogger } from './middleware/request-logger';
import healthRouter from './routes/health';
import runsRouter from './routes/runs';
import failuresRouter from './routes/failures';
import approvalsRouter from './routes/approvals';
import knowledgeRouter from './routes/knowledge';
import observabilityRouter from './routes/observability';

const app = express();

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(requestLogger);

// Routes
app.use('/', healthRouter);
app.use('/api/runs', runsRouter);
app.use('/api/failures', failuresRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/observability', observabilityRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[App] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
