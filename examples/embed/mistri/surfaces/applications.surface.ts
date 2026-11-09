/* The one surface the front end is in: the applications, the reviewers the command names, and that command. Every
   hook under the Provider reads or runs only what this declares. */
import { defineSurface } from '@mistriwork/mistri/page';

export default defineSurface({ label: 'Applications', reads: ['loan_application', 'reviewer'], commands: ['assignReviewer'] });
