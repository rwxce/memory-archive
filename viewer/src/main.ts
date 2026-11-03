import { bootViewer } from './boot';

bootViewer(document, navigator.languages?.length ? navigator.languages : [navigator.language]);
