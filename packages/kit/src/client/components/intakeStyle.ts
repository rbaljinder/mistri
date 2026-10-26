/* The intake style's sheets, apart from MultiStepForm so the stepper's first paint (a New form, a signed-in form)
   carries none of them: @mistriwork/ui's form controls (the progress bar, the step header, the action bar) and the
   style's own rules. MultiStepForm asks for this chunk when it draws the intake style; a public intake page asks
   for it before it mounts the form (publicForm.js), so its first frame is already dressed. */
import '../formControls.css';
import './MultiStepForm.css';
