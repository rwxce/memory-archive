#!/usr/bin/env node
import { buildCli } from './main';

buildCli().parseAsync(process.argv);
