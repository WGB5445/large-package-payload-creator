#!/usr/bin/env node
import { Command } from 'commander';
import { registerCreateCommand } from './commands';

const program = new Command();

program
  .name('multi-sign-cli')
  .description('A CLI tool for multi-sign large package payload creation')
  .version('1.0.0');

registerCreateCommand(program);

program.parse(process.argv);
