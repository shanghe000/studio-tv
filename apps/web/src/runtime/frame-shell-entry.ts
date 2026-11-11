import {config} from '../config';
import {initializeFrameShell} from './frame-shell';

// This fixed bundle is referenced only by the three generated dist shells.
// Keep admission inside an async function so the head runtime stays an IIFE.
initializeFrameShell({mode:config.mode,features:config.features});
