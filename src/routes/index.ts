import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import healthRouter from "./health";
import authRouter from "./auth";
import invitationsRouter from "./invitations";
import publicRouter from "./public";
import leadsRouter from "./leads";
import contactsRouter from "./contacts";
import pipelineRouter from "./pipeline";
import activitiesRouter from "./activities";
import notesRouter from "./notes";
import appointmentsRouter from "./appointments";
import notificationsRouter from "./notifications";
import analyticsRouter from "./analytics";
import aiRouter from "./ai";
import automationsRouter from "./automations";
import adminRouter from "./admin";
import tasksRouter from "./tasks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// Invitations: public accept routes + self-guarded admin routes (no global requireAuth needed)
router.use(invitationsRouter);
// Public (unauthenticated) routes: org info, lead inquiry, appointment booking, AI chatbot
router.use(publicRouter);

router.use(requireAuth);

router.use(leadsRouter);
router.use(contactsRouter);
router.use(pipelineRouter);
router.use(activitiesRouter);
router.use(notesRouter);
router.use(appointmentsRouter);
router.use(notificationsRouter);
router.use(analyticsRouter);
router.use(aiRouter);
router.use(automationsRouter);
router.use(adminRouter);
router.use(tasksRouter);

export default router;
