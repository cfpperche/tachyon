import { App } from "./App";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { mountSingleModeStudio } from "../shared/studio/singleModeStudioMain";

mountSingleModeStudio((props) => (
  <ErrorBoundary>
    <App {...props} />
  </ErrorBoundary>
));
