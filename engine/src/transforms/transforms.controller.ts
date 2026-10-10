import { Controller, Get } from '@nestjs/common';
import { TransformRegistry } from './transform.registry';

@Controller('transforms')
export class TransformsController {
  constructor(private readonly transforms: TransformRegistry) {}

  @Get()
  list() {
    return this.transforms.describe();
  }
}
